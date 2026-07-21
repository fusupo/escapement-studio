import { Inject, Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { workItemSlug } from "../../lib/context-layout.js";
import type { WorkItemRecord } from "../graph/types.js";
import { RunInteractionService } from "./run-interaction.service.js";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService, type ParsedScratchpadOpenItem } from "./scratchpad.service.js";
import type {
  ExecutionDispatchNodePreview,
  ExecutionRefinementItem,
  ExecutionRunRecord,
} from "./types.js";

export interface RunRefinementInput {
  node: ExecutionDispatchNodePreview;
  workItem: WorkItemRecord;
  scratchpadPath: string;
  issueBody: string | null;
  projectContext: string | null;
}

/**
 * Owns the worktree-specific planning pass between plan approval and coding.
 * The refinement agent session is intentionally short-lived: it ends before
 * the durable `disambiguating` gate is persisted, so no in-memory promise or
 * live agent session is required while a human reviews the result.
 */
@Injectable()
export class RunRefinementService {
  private readonly logger = new Logger(RunRefinementService.name);

  constructor(
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(ScratchpadService) private readonly scratchpadService: ScratchpadService,
    @Inject(RunInteractionService) private readonly interaction: RunInteractionService,
  ) {}

  async refine(
    initialRun: ExecutionRunRecord,
    input: RunRefinementInput,
  ): Promise<ExecutionRunRecord> {
    const startedAt = this.now();
    let run = this.runStore.updateRun(initialRun.run_id, {
      status: "running",
      phase: "refining_plan",
      started_at: initialRun.started_at ?? startedAt,
      progress_message: "Validating the approved plan against the execution worktree.",
      refinement: {
        status: "refining",
        items: [],
        started_at: startedAt,
      },
    });
    if (!run) {
      throw new Error(`run refinement record disappeared for ${initialRun.run_id}`);
    }

    const { session, modelFallbackMessage } = await this.interaction.createSession(run);
    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    run = this.runStore.updateRun(run.run_id, {
      session_id: session.sessionId,
    }) ?? run;
    this.interaction.pushActivity(
      run.run_id,
      "status_change",
      "Execution refinement started — inspecting the approved plan in the isolated worktree.",
    );
    this.runStore.appendEvent(run, {
      type: "refinement_started",
      session_id: session.sessionId,
    });
    this.runStore.emitRun("execution_status", run);

    this.interaction.registerSession(run.run_id, session);
    const unsubscribe = session.subscribe((event) => {
      this.interaction.handleSessionEvent(run!.run_id, event);
    });

    let openItems: { questions: ParsedScratchpadOpenItem[]; blockers: ParsedScratchpadOpenItem[] };
    try {
      await session.prompt(this.buildRefinementPrompt(run, input));
      const scratchpad = readFileSync(input.scratchpadPath, "utf8");
      // Validate before syncing so a malformed agent edit cannot overwrite the
      // last approved canonical plan.
      this.assertRefinementContract(scratchpad);
      openItems = this.scratchpadService.parseScratchpadOpenItems(scratchpad);
      this.scratchpadService.syncScratchpadToCanonical(run);
      this.scratchpadService.emitChecklistIfChanged(run);
    } finally {
      unsubscribe();
      this.interaction.disposeSession(run.run_id);
      session.dispose();
    }

    const items = this.toStructuredItems(openItems);
    const refinedAt = this.now();
    const questionCount = items.filter((item) => item.kind === "question").length;
    const blockerCount = items.filter((item) => item.kind === "blocker").length;

    run = this.runStore.updateRun(run.run_id, {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      session_id: undefined,
      progress_message: items.length > 0
        ? `Execution plan refined — ${questionCount} question(s) and ${blockerCount} blocker(s) require review.`
        : "Execution plan refined — review and confirm before coding.",
      refinement: {
        status: "awaiting_confirmation",
        items,
        started_at: startedAt,
        refined_at: refinedAt,
      },
    });
    if (!run) {
      throw new Error(`run refinement record disappeared for ${initialRun.run_id}`);
    }

    this.interaction.pushActivity(
      run.run_id,
      "info",
      items.length > 0
        ? `Refinement complete — presenting ${questionCount} question(s) and ${blockerCount} blocker(s).`
        : "Refinement complete — no open items; explicit execution confirmation is still required.",
    );
    this.runStore.appendEvent(run, {
      type: "refinement_completed",
      question_count: questionCount,
      blocker_count: blockerCount,
    });
    this.runStore.emitRun("execution_status", run);
    return run;
  }

  buildResolutionPrompt(run: ExecutionRunRecord): string | null {
    const refinement = run.refinement;
    if (!refinement || refinement.status !== "confirmed") return null;
    const responses = refinement.items
      .filter((item) => item.response?.trim())
      .map((item) => `- ${item.kind} ${item.id}: ${item.prompt}\n  Response: ${item.response!.trim()}`);
    const context = refinement.additional_context?.trim();
    if (responses.length === 0 && !context) return null;

    const scratchpadName = `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md`;
    return [
      `The user confirmed the refined execution plan for ${run.work_item_id}.`,
      "",
      ...(responses.length > 0 ? ["Structured responses:", ...responses, ""] : []),
      ...(context ? ["Additional context:", context, ""] : []),
      `Before coding, update ${scratchpadName} so the Clarifications Needed and Blockers sections record these decisions.`,
      "Remove resolved items or mark them resolved, and adjust the implementation checklist if the responses change the approach.",
      "Do not implement code during this response; finish by confirming the scratchpad is ready for execution.",
    ].join("\n");
  }

  private toStructuredItems(openItems: {
    questions: ParsedScratchpadOpenItem[];
    blockers: ParsedScratchpadOpenItem[];
  }): ExecutionRefinementItem[] {
    const mapItems = (
      records: ParsedScratchpadOpenItem[],
      kind: "question" | "blocker",
    ): ExecutionRefinementItem[] => records.map((record, index) => ({
      id: `${kind}-${index + 1}`,
      kind,
      prompt: record.prompt,
      ...(record.metadata ?? {}),
      selected_option_id: null,
      response: null,
    }));
    return [...mapItems(openItems.questions, "question"), ...mapItems(openItems.blockers, "blocker")];
  }

  private assertRefinementContract(content: string): void {
    const hasQuestions = /^\s*###\s+Clarifications Needed\s*$/m.test(content);
    const hasBlockers = /^\s*##\s+Blockers\s*$/m.test(content);
    if (!hasQuestions || !hasBlockers) {
      const missing = [
        ...(!hasQuestions ? ["### Clarifications Needed"] : []),
        ...(!hasBlockers ? ["## Blockers"] : []),
      ];
      throw new Error(
        `refinement_contract_invalid: scratchpad is missing required section(s): ${missing.join(", ")}`,
      );
    }
  }

  private buildRefinementPrompt(run: ExecutionRunRecord, input: RunRefinementInput): string {
    const scratchpadName = `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md`;
    const owned = input.node.files_owned.length
      ? input.node.files_owned.map((path) => `- ${path}`).join("\n")
      : "- (none predicted)";
    const shared = input.node.files_shared.length
      ? input.node.files_shared.map((file) => `- ${file.path} (${file.assessment}/${file.confidence})`).join("\n")
      : "- (none)";
    const forbidden = input.node.files_forbidden.length
      ? input.node.files_forbidden.map((path) => `- ${path}`).join("\n")
      : "- (none)";

    return [
      `# Execution Refinement for ${run.work_item_id}: ${run.work_item_name}`,
      "",
      "You are inside the isolated execution worktree. An initial plan was already reviewed and approved; do not code yet.",
      "Your job is to validate that plan against the exact checked-out code and turn it into an execution-ready contract.",
      "",
      "## Required work",
      "",
      `1. Read ${scratchpadName} completely.`,
      "2. Inspect the relevant implementation and test files in this worktree.",
      "3. Correct stale assumptions, refine task ordering, and make every checklist item concrete and file-specific.",
      "4. Reconcile the Affected Files section with what this checkout actually requires.",
      "5. Put every decision the user must make under `### Clarifications Needed` as a `- ` bullet.",
      "6. Put every condition that prevents safe implementation under `## Blockers` as a `- ` bullet.",
      "7. If either section has no items, write `_(none)_` under that heading.",
      `8. Save the refined plan back to ${scratchpadName}.`,
      "",
      "## Selectable decision encoding",
      "",
      "Keep open-ended decisions as plain `- ` bullets. When a decision is safely bounded, provide two to four mutually exclusive choices by placing this exact two-space-indented metadata fence immediately beneath the top-level bullet:",
      "",
      "- Which implementation should be used?",
      "  ```execution-refinement",
      "  {",
      "    \"options\": [",
      "      { \"id\": \"narrow\", \"label\": \"Use the narrow change\", \"description\": \"Limits impact to the current workflow.\" },",
      "      { \"id\": \"broad\", \"label\": \"Use the broad change\" }",
      "    ],",
      "    \"recommended_option_id\": \"narrow\",",
      "    \"allow_other\": true",
      "  }",
      "  ```",
      "",
      "Option IDs and labels must be unique/concise; descriptions are optional. Recommendations are display-only and must not silently choose an answer. Set `allow_other` only when free text is safe; it defaults to false. Invalid metadata degrades to a plain free-text bullet.",
      "For blockers, prefer bounded choices such as accepting a narrow override or revising the plan. A real cancellation choice is allowed only on a blocker option with `\"action\": \"cancel_execution\"`; selecting it abandons this run and returns the work item to `ready` instead of coding.",
      "",
      "## Issue context",
      `Repo: ${input.workItem.repo ?? "(not set)"}`,
      `Issue URL: ${input.workItem.issue_url ?? "(not set)"}`,
      `Scope hint: ${input.workItem.scope_hint ?? "(not set)"}`,
      `Branch: ${input.node.branch}`,
      `Base ref: ${input.node.default_base_ref}`,
      ...(input.issueBody ? ["", "### Issue body", "", input.issueBody] : []),
      "",
      "## Dispatch ownership",
      "Owned:",
      owned,
      "",
      "Shared:",
      shared,
      "",
      "Forbidden to modify (reading is allowed):",
      forbidden,
      ...(input.projectContext
        ? ["", "## Project conventions (AGENTS.md / CLAUDE.md)", "", input.projectContext]
        : []),
      "",
      "Do not write implementation code or create commits. The user must confirm this refined plan before coding starts.",
    ].join("\n");
  }

  private now(): string {
    return new Date().toISOString();
  }
}
