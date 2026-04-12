import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../../config.js";
import {
  canonicalScratchpadPath,
  ensurePlanDir,
  readPlanMetadata,
  writePlanMetadata,
  type PlanMetadata,
} from "../../lib/context-layout.js";
import { fetchIssueBody } from "../../lib/github-cli.js";
import {
  StudioIssueTemplateService,
  type StudioIssueTemplate,
} from "../github/studio-issue-template.service.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { PlanDrafterService } from "./plan-drafter.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import type {
  ApprovePlanDto,
  PlanDraftEnvelope,
  PlanResponse,
  PredictedFilesDiff,
  ReopenPlanDto,
} from "./types.js";

/**
 * ADR 014 step 4 — the plan preparation service.
 *
 * Splits scratchpad drafting out of the execution launch path so a plan can
 * be drafted, reviewed, and approved independently of any run. Prepare does
 * NOT create a worktree; the worktree still lives inside the execution flow
 * and is created on launch.
 *
 * Lifecycle:
 *   planned → drafting  (prepare)
 *   drafting → ready    (approve)
 *   ready → drafting    (reopen)
 *
 * See `docs/adr/014-plans-runs-state-model.md` and
 * `docs/contracts/plan-and-run-lifecycle.md` for the full contract.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);

  constructor(
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(StudioIssueTemplateService) private readonly templateService: StudioIssueTemplateService,
    @Inject(PlanDrafterService) private readonly drafter: PlanDrafterService,
  ) {}

  /* ── Public API ────────────────────────────────────────────────────────── */

  /**
   * Draft (or re-draft) the canonical scratchpad for a work item and
   * transition it to the `drafting` state. No worktree is created.
   *
   * Per ADR 014 step 8 follow-up (#167), every call invokes
   * `PlanDrafterService.draft()` to produce a fresh `PlanDraftEnvelope` from
   * a one-shot pi-coding-agent session. The envelope is injected into the
   * canonical scratchpad and the work item's `predicted_files` is refreshed
   * from the envelope's `affected_files`.
   *
   * **Always re-drafts.** Re-running prepare on a work item already in
   * `drafting` state runs the drafter again from scratch — no carry-forward
   * of prior content. If you want to preserve manual edits, hit Approve
   * (which transitions to `ready`) before re-clicking Prepare.
   *
   * **Fails loud.** If the drafter throws (network error, malformed JSON,
   * agent failure), the exception propagates and the work item state does
   * NOT transition. The existing scratchpad and metadata are not modified.
   *
   * Valid pre-states: `planned`, `drafting`. Everything else throws
   * `BadRequestException`.
   */
  async prepare(workItemId: string): Promise<PlanResponse> {
    const workItem = this.workItemsService.get(workItemId);
    this.assertPreparable(workItem);

    // Fetch the issue body once and pass it into both the drafter and the
    // renderer. The drafter doesn't need its own gh access.
    const issueBody = fetchIssueBody(workItem.repo, workItem.issue_number);

    // Run the drafter BEFORE any state mutation. If this throws, no state
    // changes are visible and the caller can retry.
    const draft = await this.drafter.draft(workItem, issueBody);

    return this.persistDraftEnvelope(workItemId, draft, issueBody, {
      transitionToDrafting: workItem.state !== "drafting",
    });
  }

  /**
   * Approve a drafted plan: transition `drafting → ready`, auto-refine the
   * work item's `predicted_files` from the scratchpad's `## Affected Files`
   * section, and return the diff for review UIs.
   */
  async approve(workItemId: string, dto: ApprovePlanDto = {}): Promise<PlanResponse> {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "drafting") {
      throw new BadRequestException(
        `Cannot approve plan for ${workItemId}: expected state 'drafting', got '${workItem.state}'`,
      );
    }

    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, workItemId);
    if (!existsSync(canonicalPath)) {
      throw new NotFoundException(
        `Cannot approve plan for ${workItemId}: canonical scratchpad not found at ${canonicalPath}`,
      );
    }
    const scratchpadContent = readFileSync(canonicalPath, "utf8");

    // Compute the predicted_files diff from the scratchpad.
    const extracted = this.extractAffectedFiles(scratchpadContent);
    const diff = this.diffPredictedFiles(workItem.predicted_files, extracted);

    // Apply the refinement only if the scratchpad's Affected Files section
    // produced something. If it is empty/absent, preserve the current value.
    if (extracted.length > 0) {
      this.workItemsService.update(workItemId, { predicted_files: extracted });
    }

    // Transition drafting → ready.
    await this.hsmService.dispatch(workItemId, { type: "draft.completed" });

    const now = new Date().toISOString();
    const approvedBy = dto.approved_by?.trim() || "local";
    const metadata = this.updatePlanMetadata(workItemId, (current) => ({
      ...current,
      state: "ready",
      approved_at: now,
      approved_by: approvedBy,
    }));

    this.logger.log(
      `Plan approved for ${workItemId} by ${approvedBy}: ` +
        `${diff.added.length} added, ${diff.removed.length} removed, ${diff.unchanged.length} unchanged`,
    );

    return {
      work_item_id: workItemId,
      metadata,
      scratchpad_content: scratchpadContent,
      predicted_files_diff: diff,
    };
  }

  /**
   * Reopen an approved plan for further editing: `ready → drafting`. Clears
   * approver fields in metadata.
   */
  async reopen(workItemId: string, _dto: ReopenPlanDto = {}): Promise<PlanResponse> {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "ready") {
      throw new BadRequestException(
        `Cannot reopen plan for ${workItemId}: expected state 'ready', got '${workItem.state}'`,
      );
    }

    await this.hsmService.dispatch(workItemId, { type: "user.start_draft" });

    const metadata = this.updatePlanMetadata(workItemId, (current) => ({
      ...current,
      state: "drafting",
      approved_at: null,
      approved_by: null,
    }));

    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, workItemId);
    const scratchpadContent = existsSync(canonicalPath) ? readFileSync(canonicalPath, "utf8") : "";

    return {
      work_item_id: workItemId,
      metadata,
      scratchpad_content: scratchpadContent,
    };
  }

  /**
   * Fetch plan metadata + scratchpad content for a work item. Returns 404 if
   * the plan dir does not exist yet.
   */
  get(workItemId: string): PlanResponse {
    // Validate the work item exists (throws NotFoundException if not).
    this.workItemsService.get(workItemId);

    const metadata = readPlanMetadata(this.artifactRoot, workItemId);
    if (!metadata) {
      throw new NotFoundException(
        `No plan found for work item ${workItemId}. Call POST /api/plans/${workItemId}/prepare first.`,
      );
    }

    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, workItemId);
    const scratchpadContent = existsSync(canonicalPath) ? readFileSync(canonicalPath, "utf8") : "";

    return {
      work_item_id: workItemId,
      metadata,
      scratchpad_content: scratchpadContent,
    };
  }

  async persistDraftEnvelope(
    workItemId: string,
    draft: PlanDraftEnvelope,
    issueBody: string | null,
    options: { transitionToDrafting?: boolean } = {},
  ): Promise<PlanResponse> {
    if (draft.affected_files.length > 0) {
      this.workItemsService.update(workItemId, {
        predicted_files: draft.affected_files,
      });
    }

    if (options.transitionToDrafting) {
      await this.hsmService.dispatch(workItemId, { type: "user.start_draft" });
    }

    ensurePlanDir(this.artifactRoot, workItemId);

    const refreshed = this.workItemsService.get(workItemId);
    const templates = this.templateService.listTemplates();
    const scratchpadContent = this.renderPlanScratchpad(
      refreshed,
      issueBody,
      templates,
      draft,
    );
    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, workItemId);
    writeFileSync(canonicalPath, scratchpadContent, "utf8");

    const metadata = this.updatePlanMetadata(workItemId, (current) => ({
      ...current,
      state: "drafting",
      scratchpad_path: canonicalPath,
    }));

    return {
      work_item_id: workItemId,
      metadata,
      scratchpad_content: scratchpadContent,
    };
  }

  /* ── Private helpers ───────────────────────────────────────────────────── */

  private assertPreparable(workItem: WorkItemRecord): void {
    const preparable: WorkItemState[] = ["planned", "drafting"];
    if (!preparable.includes(workItem.state)) {
      throw new BadRequestException(
        `Cannot prepare plan for ${workItem.id}: expected state in [${preparable.join(", ")}], got '${workItem.state}'`,
      );
    }
  }

  /**
   * Generate a skeleton scratchpad for a work item in the plan phase (no run
   * context yet). Seeded from the issue body and the Studio issue templates.
   * No sub-agent call — per Q2 decision, prepare writes structure only.
   */
  buildPlanScratchpad(workItem: WorkItemRecord): string {
    const issueBody = fetchIssueBody(workItem.repo, workItem.issue_number);
    const templates = this.templateService.listTemplates();
    return this.renderPlanScratchpad(workItem, issueBody, templates);
  }

  /**
   * Pure rendering function for the plan scratchpad. Separated from
   * `buildPlanScratchpad` so tests can drive it with injected issue bodies,
   * templates, and (optionally) a `PlanDraftEnvelope` from the auto-drafter
   * (#167) without mocking `gh`, the filesystem, or pi-coding-agent.
   *
   * When `draft` is omitted, renders the legacy stub template with
   * `(to be filled in)` placeholders. When `draft` is provided, every
   * drafter-driven section is filled from the envelope.
   */
  renderPlanScratchpad(
    workItem: WorkItemRecord,
    issueBody: string | null,
    templates: StudioIssueTemplate[],
    draft?: PlanDraftEnvelope,
  ): string {
    const templateSummary = templates.length
      ? templates
          .map((template) => `- ${template.kind}: ${template.name}`)
          .join("\n")
      : "- (no Studio issue templates found under .github/ISSUE_TEMPLATE)";

    const issueSection = issueBody
      ? ["## Issue Body", "", issueBody.trim(), ""]
      : ["## Issue Body", "", "_(issue body unavailable — link to issue: " + (workItem.issue_url ?? "(not linked)") + ")_", ""];

    // ── Drafter-driven sections (or legacy stubs when no draft) ────────────
    const summarySection = draft
      ? ["## Summary", "", draft.summary, ""]
      : [
          "## Summary",
          "<!-- One-paragraph statement of what this plan proposes. Fill during drafting. -->",
          "",
        ];

    const acceptanceCriteriaSection = draft
      ? [
          "## Acceptance Criteria",
          "",
          ...(draft.acceptance_criteria.length
            ? draft.acceptance_criteria.map((c) => `- [ ] ${c}`)
            : ["- [ ] (drafter returned no acceptance criteria)"]),
          "",
        ]
      : [
          "## Acceptance Criteria",
          "<!-- Copy from the issue body if present, refine during drafting. -->",
          "",
          "- [ ] (to be filled in)",
          "",
        ];

    const implementationPlanSection = draft
      ? [
          "## Implementation Plan",
          "",
          ...(draft.implementation_tasks.length
            ? draft.implementation_tasks.flatMap((task) => [
                `- [ ] ${task.description}`,
                `  - **Files:** ${task.files.length ? task.files.join(", ") : "(none)"}`,
                `  - **Why:** ${task.rationale}`,
                `  - **Testing:** ${task.testing}`,
              ])
            : ["- [ ] (drafter returned no implementation tasks)"]),
          "",
        ]
      : [
          "## Implementation Plan",
          "<!-- Atomic, committable tasks. Populate during drafting; approver reviews. -->",
          "",
          "- [ ] (to be filled in)",
          "",
        ];

    const affectedFilesLines = draft
      ? draft.affected_files.length
        ? draft.affected_files.map((p) => `- ${p}`)
        : ["- (drafter returned no affected files)"]
      : workItem.predicted_files.length
        ? workItem.predicted_files.map((p) => `- ${p}`)
        : ["- (none predicted yet — populate during plan review)"];

    const affectedFilesSection = [
      "## Affected Files",
      "<!-- Predicted files this plan will touch. Approval refines the work item's predicted_files from this list. -->",
      "",
      ...affectedFilesLines,
      "",
    ];

    const technicalNotesSection = draft
      ? [
          "## Technical Notes",
          "",
          "### Architecture Considerations",
          "",
          draft.technical_notes.architecture,
          "",
          "### Implementation Approach",
          "",
          draft.technical_notes.approach,
          "",
          "### Potential Challenges",
          "",
          draft.technical_notes.challenges,
          "",
        ]
      : [];

    const questionsSection = draft
      ? [
          "## Questions / Concerns",
          "",
          "### Clarifications Needed",
          "",
          ...(draft.questions.length
            ? draft.questions.map((q) => `- ${q}`)
            : ["_(none)_"]),
          "",
          "### Assumptions Made",
          "",
          ...(draft.assumptions.length
            ? draft.assumptions.map((a) => `- ${a}`)
            : ["_(none)_"]),
          "",
        ]
      : [
          "## Questions / Concerns",
          "<!-- Surface ambiguities here. Resolve before approval. -->",
          "",
        ];

    const blockersSection = draft
      ? [
          "## Blockers",
          "",
          ...(draft.blockers.length
            ? draft.blockers.map((b) => `- ${b}`)
            : ["_(none)_"]),
          "",
        ]
      : ["## Blockers", ""];

    const drafterBanner = draft
      ? "> Auto-drafted by PlansService.prepare via PlanDrafterService (ADR 014 step 8 follow-up, #167)."
      : "> Drafted by PlansService.prepare (ADR 014 step 4). Worktree not yet created.";

    return [
      `# Plan: ${workItem.id} — ${workItem.name}`,
      "",
      drafterBanner,
      "",
      "## Context",
      `- **Work item:** ${workItem.id}`,
      `- **Repo:** ${workItem.repo ?? "(not set)"}`,
      `- **Issue:** ${workItem.issue_url ?? "(not linked)"}`,
      `- **Scope hint:** ${workItem.scope_hint ?? "(not set)"}`,
      `- **Branch:** ${workItem.branch ?? "(not set)"}`,
      "",
      ...issueSection,
      ...summarySection,
      ...acceptanceCriteriaSection,
      ...implementationPlanSection,
      ...affectedFilesSection,
      ...technicalNotesSection,
      "## Quality Checks",
      "- [ ] `npx tsc --noEmit`",
      "- [ ] `npx vitest run`",
      "- [ ] `npx vite build --config web/vite.config.ts`",
      "",
      ...questionsSection,
      "## Studio Issue Templates Available",
      templateSummary,
      "",
      "## Work Log",
      "",
      `### ${new Date().toISOString().slice(0, 10)} - Plan drafted`,
      draft
        ? "- Scratchpad auto-drafted by PlansService.prepare via PlanDrafterService"
        : "- Scratchpad created by PlansService.prepare",
      "",
      ...blockersSection,
    ].join("\n");
  }

  /**
   * Parse the `## Affected Files` section of a scratchpad. Returns a deduped,
   * stable-ordered list of file paths. List items may include inline notes
   * separated by `—` or `(` — only the path portion is captured.
   *
   * If the section is missing or empty, returns `[]`.
   */
  extractAffectedFiles(scratchpadContent: string): string[] {
    const lines = scratchpadContent.split(/\r?\n/);
    let inSection = false;
    const collected: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
      if (headingMatch) {
        const heading = headingMatch[1].trim().toLowerCase();
        if (heading === "affected files") {
          inSection = true;
          continue;
        }
        if (inSection) {
          // Left the section on the next ## heading
          break;
        }
      }

      if (!inSection) continue;

      // Skip HTML comments, empty lines, and non-list lines
      const listMatch = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (!listMatch) continue;

      let item = listMatch[1].trim();
      if (!item) continue;
      // Strip inline notes (e.g. `src/foo.ts — add helper` or `src/foo.ts (new)`)
      const dashIdx = item.indexOf(" —");
      if (dashIdx !== -1) item = item.slice(0, dashIdx).trim();
      const parenIdx = item.indexOf(" (");
      if (parenIdx !== -1) item = item.slice(0, parenIdx).trim();
      // Strip surrounding backticks that some authors use for monospace
      item = item.replace(/^`+|`+$/g, "").trim();
      // Skip bare comments and placeholders
      if (!item || item.startsWith("(")) continue;

      if (!seen.has(item)) {
        seen.add(item);
        collected.push(item);
      }
    }

    return collected;
  }

  /**
   * Compute the diff between the current `predicted_files` and a new list
   * extracted from the plan.
   */
  diffPredictedFiles(current: string[], next: string[]): PredictedFilesDiff {
    const currentSet = new Set(current);
    const nextSet = new Set(next);
    const added = next.filter((f) => !currentSet.has(f));
    const removed = current.filter((f) => !nextSet.has(f));
    const unchanged = next.filter((f) => currentSet.has(f));
    return { added, removed, unchanged };
  }

  /**
   * Read, mutate, and write plan metadata in a single step, bumping
   * `updated_at` to now.
   */
  private updatePlanMetadata(
    workItemId: string,
    mutator: (current: PlanMetadata) => PlanMetadata,
  ): PlanMetadata {
    const current = readPlanMetadata(this.artifactRoot, workItemId);
    if (!current) {
      throw new Error(
        `updatePlanMetadata: plan dir for ${workItemId} missing — call ensurePlanDir first`,
      );
    }
    const mutated: PlanMetadata = {
      ...mutator(current),
      updated_at: new Date().toISOString(),
    };
    writePlanMetadata(this.artifactRoot, workItemId, mutated);
    return mutated;
  }
}
