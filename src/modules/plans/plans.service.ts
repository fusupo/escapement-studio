import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
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
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import type {
  ApprovePlanDto,
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
    private readonly workItemsService: WorkItemsService,
    private readonly templateService: StudioIssueTemplateService,
  ) {}

  /* ── Public API ────────────────────────────────────────────────────────── */

  /**
   * Draft (or re-draft) the canonical scratchpad for a work item and
   * transition it to the `drafting` state. No worktree is created.
   *
   * - If the canonical scratchpad already exists and is non-empty, its
   *   contents are carried forward unchanged (so in-progress plan edits are
   *   not destroyed).
   * - If it is absent or empty, a fresh skeleton is generated from the issue
   *   body and Studio issue templates.
   *
   * Valid pre-states: `planned`, `drafting`. Everything else throws
   * `BadRequestException`.
   */
  prepare(workItemId: string): PlanResponse {
    const workItem = this.workItemsService.get(workItemId);
    this.assertPreparable(workItem);

    // Transition work item state FIRST so concurrent prepare requests for
    // the same work item fail fast on the state guard (they will observe
    // `drafting`, not `planned`, if they lose the race). The state guard
    // allows drafting → drafting (re-prepare) but rejects everything else.
    const transitioned =
      workItem.state === "drafting"
        ? workItem
        : this.workItemsService.update(workItemId, { state: "drafting" });

    // Ensure the plan dir exists and write initial metadata if we were first.
    ensurePlanDir(this.artifactRoot, workItemId);

    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, workItemId);
    let scratchpadContent: string;
    if (existsSync(canonicalPath)) {
      const existing = readFileSync(canonicalPath, "utf8");
      if (existing.trim().length > 0) {
        scratchpadContent = existing;
      } else {
        scratchpadContent = this.generateSkeleton(transitioned);
        writeFileSync(canonicalPath, scratchpadContent, "utf8");
      }
    } else {
      scratchpadContent = this.generateSkeleton(transitioned);
      writeFileSync(canonicalPath, scratchpadContent, "utf8");
    }

    // Update plan metadata to reflect drafting state.
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

  /**
   * Approve a drafted plan: transition `drafting → ready`, auto-refine the
   * work item's `predicted_files` from the scratchpad's `## Affected Files`
   * section, and return the diff for review UIs.
   */
  approve(workItemId: string, dto: ApprovePlanDto = {}): PlanResponse {
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
    this.workItemsService.update(workItemId, { state: "ready" });

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
  reopen(workItemId: string, _dto: ReopenPlanDto = {}): PlanResponse {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "ready") {
      throw new BadRequestException(
        `Cannot reopen plan for ${workItemId}: expected state 'ready', got '${workItem.state}'`,
      );
    }

    this.workItemsService.update(workItemId, { state: "drafting" });

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
   * Pure rendering function for the plan scratchpad skeleton. Separated from
   * `buildPlanScratchpad` so tests can drive it with injected issue bodies
   * and templates without mocking `gh` or the filesystem.
   */
  renderPlanScratchpad(
    workItem: WorkItemRecord,
    issueBody: string | null,
    templates: StudioIssueTemplate[],
  ): string {
    const predictedOwned = workItem.predicted_files.length
      ? workItem.predicted_files.map((path) => `- ${path}`).join("\n")
      : "- (none predicted yet — populate during plan review)";

    const templateSummary = templates.length
      ? templates
          .map((template) => `- ${template.kind}: ${template.name}`)
          .join("\n")
      : "- (no Studio issue templates found under .github/ISSUE_TEMPLATE)";

    const issueSection = issueBody
      ? ["## Issue Body", "", issueBody.trim(), ""]
      : ["## Issue Body", "", "_(issue body unavailable — link to issue: " + (workItem.issue_url ?? "(not linked)") + ")_", ""];

    return [
      `# Plan: ${workItem.id} — ${workItem.name}`,
      "",
      "> Drafted by PlansService.prepare (ADR 014 step 4). Worktree not yet created.",
      "",
      "## Context",
      `- **Work item:** ${workItem.id}`,
      `- **Repo:** ${workItem.repo ?? "(not set)"}`,
      `- **Issue:** ${workItem.issue_url ?? "(not linked)"}`,
      `- **Scope hint:** ${workItem.scope_hint ?? "(not set)"}`,
      `- **Branch:** ${workItem.branch ?? "(not set)"}`,
      "",
      ...issueSection,
      "## Summary",
      "<!-- One-paragraph statement of what this plan proposes. Fill during drafting. -->",
      "",
      "## Acceptance Criteria",
      "<!-- Copy from the issue body if present, refine during drafting. -->",
      "",
      "- [ ] (to be filled in)",
      "",
      "## Implementation Plan",
      "<!-- Atomic, committable tasks. Populate during drafting; approver reviews. -->",
      "",
      "- [ ] (to be filled in)",
      "",
      "## Affected Files",
      "<!-- Predicted files this plan will touch. Approval refines the work item's predicted_files from this list. -->",
      "",
      predictedOwned,
      "",
      "## Quality Checks",
      "- [ ] `npx tsc --noEmit`",
      "- [ ] `npx vitest run`",
      "- [ ] `npx vite build --config web/vite.config.ts`",
      "",
      "## Questions / Concerns",
      "<!-- Surface ambiguities here. Resolve before approval. -->",
      "",
      "## Studio Issue Templates Available",
      templateSummary,
      "",
      "## Work Log",
      "",
      `### ${new Date().toISOString().slice(0, 10)} - Plan drafted`,
      "- Scratchpad created by PlansService.prepare",
      "",
      "## Blockers",
      "",
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

  /** Alias used by `prepare` for clarity at the call site. */
  private generateSkeleton(workItem: WorkItemRecord): string {
    return this.buildPlanScratchpad(workItem);
  }
}
