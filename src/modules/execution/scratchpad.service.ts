import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import {
  canonicalScratchpadPath,
  ensurePlanDir,
  readPlanMetadata,
  workItemSlug,
} from "../../lib/context-layout.js";
import { sanitizeRefinementMetadata } from "./refinement-response.js";
import { RunStore } from "./run-store.service.js";
import { WorktreeService } from "./worktree.service.js";
import type {
  ChecklistItem,
  ChecklistItemCategory,
  ExecutionChecklistSnapshot,
  ExecutionDispatchNodePreview,
  ExecutionRefinementItemKind,
  ExecutionRunRecord,
} from "./types.js";

export interface ParsedScratchpadOpenItem {
  prompt: string;
  metadata?: NonNullable<ReturnType<typeof sanitizeRefinementMetadata>>;
}

/**
 * Phase 4c of the cqrs refactor (#232): owns canonical scratchpad
 * management, the ADR-014 phase-boundary sync dance, the
 * `SCRATCHPAD_*.md` commit guards, and the implementation-plan
 * checklist parser. Extracted verbatim from ExecutionService.
 *
 * Injects both WorktreeService (for `runGitIn` in the commit guards)
 * and RunStore (for `emitEvent` in the checklist SSE push). First
 * Phase 4 sub-service with inter-sibling dependencies; neither
 * dependency is circular so no forwardRef is required.
 *
 * HTTP getters (`getRunChecklist` / `getRunScratchpad`) take an
 * `ExecutionRunRecord` directly rather than doing their own lookup;
 * ExecutionService is the orchestrator that resolves the run via
 * RunStore before delegating, matching the Phase 4b `cleanupWorktree`
 * passthrough pattern.
 */
@Injectable()
export class ScratchpadService {
  private readonly logger = new Logger(ScratchpadService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  constructor(
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
  ) {}

  // ─── HTTP getter helpers ──────────────────────────────────────────

  getRunChecklist(run: ExecutionRunRecord): ExecutionChecklistSnapshot {
    const items = this.readChecklistFromWorktree(run);
    if (items !== null) {
      const projected = this.runStore.persistChecklistProjection(run.run_id, items);
      if (projected) return projected;
    }

    const durable = this.runStore.getRun(run.run_id)?.checklist ?? run.checklist;
    return durable ?? this.emptyChecklist(run.run_id);
  }

  getRunScratchpad(run: ExecutionRunRecord): { run_id: string; content: string | null } {
    // Prefer the canonical plan file (source of truth, synced at each phase boundary)
    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
    if (existsSync(canonicalPath)) {
      return { run_id: run.run_id, content: readFileSync(canonicalPath, "utf8") };
    }

    // Fall back to the live worktree copy (active run before first sync-back)
    const slug = workItemSlug(run.work_item_id);
    const worktreePath = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    if (existsSync(worktreePath)) {
      return { run_id: run.run_id, content: readFileSync(worktreePath, "utf8") };
    }

    return { run_id: run.run_id, content: null };
  }

  // ─── Checklist parsing + SSE push ─────────────────────────────────

  /**
   * Project the canonical execution checklists from a scratchpad.
   *
   * Prepared scratchpads can include issue-body headings before the canonical
   * execution contract, so the last exact H2 for each supported heading wins.
   * H3 content remains inside its parent section; the next H2 ends it.
   */
  parseChecklistProjection(content: string): ChecklistItem[] {
    const lines = content.split(/\r?\n/);
    const sections: Array<{ heading: string; category: ChecklistItemCategory }> = [
      { heading: "Acceptance Criteria", category: "acceptance" },
      { heading: "Implementation Plan", category: "implementation" },
      { heading: "Quality Checks", category: "verification" },
      { heading: "Manual Verification", category: "verification" },
    ];

    return sections.flatMap(({ heading, category }) => {
      let sectionStart = -1;
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() === `## ${heading}`) {
          sectionStart = index + 1;
        }
      }
      if (sectionStart < 0) return [];

      const items: ChecklistItem[] = [];
      for (let index = sectionStart; index < lines.length; index += 1) {
        if (/^\s*##(?:\s|$)/.test(lines[index])) break;
        const match = lines[index].match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
        if (match) {
          items.push({
            checked: match[1].toLowerCase() === "x",
            text: match[2].trim(),
            category,
          });
        }
      }
      return items;
    });
  }

  /** @deprecated Use parseChecklistProjection for categorized checklist data. */
  parseImplementationPlanChecklist(content: string): ChecklistItem[] {
    return this.parseChecklistProjection(content).filter((item) => item.category === "implementation");
  }

  readChecklistFromWorktree(run: ExecutionRunRecord): ChecklistItem[] | null {
    const slug = workItemSlug(run.work_item_id);
    const scratchpadPath = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    if (!existsSync(scratchpadPath)) {
      return null;
    }
    try {
      const content = readFileSync(scratchpadPath, "utf8");
      return this.parseChecklistProjection(content);
    } catch {
      return null;
    }
  }

  emitChecklistIfChanged(run: ExecutionRunRecord, republishUnchanged = false): void {
    const items = this.readChecklistFromWorktree(run);
    if (items !== null) {
      this.runStore.persistChecklistProjection(run.run_id, items, { republishUnchanged });
      return;
    }

    if (republishUnchanged) {
      const durable = this.runStore.getRun(run.run_id)?.checklist ?? run.checklist;
      if (durable) {
        this.runStore.persistChecklistProjection(run.run_id, durable.items, { republishUnchanged: true });
      }
    }
  }

  private emptyChecklist(runId: string): ExecutionChecklistSnapshot {
    return {
      run_id: runId,
      revision: 0,
      updated_at: null,
      items: [],
      completed: 0,
      total: 0,
    };
  }

  // ─── Scratchpad rendering + canonical sync ────────────────────────

  /** Build a structured scratchpad markdown document for the execution worktree. */
  buildScratchpad(run: ExecutionRunRecord, node: ExecutionDispatchNodePreview): string {
    const owned = node.files_owned.length
      ? node.files_owned.map((path) => `- ${path}`).join("\n")
      : "- (none predicted)";
    const shared = node.files_shared.length
      ? node.files_shared.map((file) => `- ${file.path} (${file.assessment}/${file.confidence})`).join("\n")
      : "- (none)";
    const forbidden = node.files_forbidden.length
      ? node.files_forbidden.map((path) => `- ${path}`).join("\n")
      : "- (none)";

    return [
      `# Scratchpad: ${run.work_item_id} — ${run.work_item_name}`,
      "",
      "## Context",
      `- **Repo:** ${run.repo ?? "(not set)"}`,
      `- **Issue:** ${run.issue_url ?? "(not linked)"}`,
      `- **Branch:** ${run.branch}`,
      `- **Base ref:** ${run.base_ref}`,
      `- **Scope hint:** ${node.scope_hint ?? "(not set)"}`,
      `- **Created:** ${run.created_at}`,
      "",
      "## File Ownership",
      "",
      "### Owned",
      owned,
      "",
      "### Shared",
      shared,
      "",
      "### Forbidden",
      forbidden,
      "",
      "## Acceptance Criteria",
      "<!-- Fill in from the issue body during setup phase -->",
      "",
      "- [ ] (to be filled by setup phase)",
      "",
      "## Implementation Plan",
      "<!-- The setup phase agent will replace these with specific, concrete tasks -->",
      "",
      "- [ ] Analyze scope and identify changes needed",
      "- [ ] Implement changes",
      "- [ ] Run tests / verify",
      "- [ ] Summarize results",
      "",
      "## Affected Files",
      "<!-- List specific files that will be modified, with what changes -->",
      "",
      "## Quality Checks",
      "- [ ] TypeScript compilation passes (`npm run check`)",
      "- [ ] Tests pass (`npm test`)",
      "- [ ] Build succeeds (`npm run build:web`)",
      "",
      "## Questions / Concerns",
      "<!-- Surface any ambiguities during setup — resolve with user before coding -->",
      "",
      "## Work Log",
      "",
      `### ${new Date().toISOString().slice(0, 10)} - Setup`,
      "- Scratchpad created by Studio execution service",
      `- Branch: ${run.branch}`,
      "",
      "## Blockers",
      "",
    ].join("\n");
  }

  /**
   * Parse a scratchpad's `### Clarifications Needed` and `## Blockers`
   * sections into string arrays of open items.
   *
   * Contract: matches the shape written by `PlansService.prepare`
   * (plans.service.ts ~lines 383–415) — flat top-level `- ` bullets,
   * or a single `_(none)_` sentinel when the drafter surfaced no items.
   *
   * Behavior:
   *   - Scans line-by-line for the two headings.
   *   - Collects lines starting with `- ` as bullet items until the next
   *     `#`-prefixed heading line (any level — keeps the parser simple
   *     and matches the flat structure the drafter emits).
   *   - Filters out blank lines and the `_(none)_` sentinel so an empty
   *     section reads as an empty array.
   *   - Missing heading → empty array for that section.
   *
   * Used by `executeRun` when an approved plan is loaded to decide
   * whether the disambiguation gate should fire before coding starts.
   */
  parseScratchpadOpenItems(content: string): {
    questions: ParsedScratchpadOpenItem[];
    blockers: ParsedScratchpadOpenItem[];
  } {
    const lines = content.split(/\r?\n/);
    const collect = (
      headingMatch: (line: string) => boolean,
      kind: ExecutionRefinementItemKind,
    ): ParsedScratchpadOpenItem[] => {
      const items: ParsedScratchpadOpenItem[] = [];
      let i = 0;
      while (i < lines.length) {
        if (headingMatch(lines[i])) {
          i += 1;
          while (i < lines.length) {
            const line = lines[i];
            if (/^\s*#/.test(line)) break;
            const bullet = /^\s*-\s+(.+?)\s*$/.exec(line);
            if (!bullet) {
              i += 1;
              continue;
            }
            const prompt = bullet[1].trim();
            if (!prompt || prompt === "_(none)_") {
              i += 1;
              continue;
            }

            let metadata: ParsedScratchpadOpenItem["metadata"];
            // Metadata is deliberately stricter than legacy bullet parsing:
            // both the bullet and its immediately adjacent fence are fixed at
            // the documented indentation so detached/nested fences cannot bind.
            if (line.startsWith("- ") && lines[i + 1] === "  ```execution-refinement") {
              const jsonLines: string[] = [];
              let closing = i + 2;
              while (closing < lines.length && lines[closing] !== "  ```") {
                if (!lines[closing].startsWith("  ")) break;
                jsonLines.push(lines[closing].slice(2));
                closing += 1;
              }
              if (closing < lines.length && lines[closing] === "  ```") {
                try {
                  metadata = sanitizeRefinementMetadata(JSON.parse(jsonLines.join("\n")), kind) ?? undefined;
                } catch {
                  metadata = undefined;
                }
                i = closing;
              }
            }
            items.push({ prompt, ...(metadata ? { metadata } : {}) });
            i += 1;
          }
          break;
        }
        i += 1;
      }
      return items;
    };
    const questions = collect((line) => /^\s*#{2,3}\s+Clarifications Needed\s*$/.test(line), "question");
    const blockers = collect((line) => /^\s*#{2,3}\s+Blockers\s*$/.test(line), "blocker");
    return { questions, blockers };
  }

  /**
   * Sync the agent's worktree scratchpad back to the canonical plan file.
   *
   * Called at each phase boundary in executeRun. If the worktree copy is
   * missing (e.g. the agent deleted it), logs a warning and leaves the
   * canonical file unchanged — the canonical retains its last-known-good
   * state.
   */
  syncScratchpadToCanonical(run: ExecutionRunRecord): void {
    const slug = workItemSlug(run.work_item_id);
    const worktreeScratchpad = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    const canonical = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
    if (!existsSync(worktreeScratchpad)) {
      this.logger.warn(
        `syncScratchpadToCanonical: worktree scratchpad missing for run ${run.run_id} ` +
          `at ${worktreeScratchpad}; canonical left unchanged.`,
      );
      return;
    }
    writeFileSync(canonical, readFileSync(worktreeScratchpad, "utf8"), "utf8");
  }

  /**
   * Seed the worktree scratchpad from the canonical plan file.
   *
   * ADR 014 step 2/4/5: the canonical scratchpad lives at
   * `plans/<slug>/SCRATCHPAD_<slug>.md` and is the source of truth.
   *
   * After ADR 014 step 4 lands, a work item that reached `ready` state via
   * `PlansService.approve` already has an approved canonical scratchpad —
   * no skeleton synthesis happens here and the setup-phase agent turn is
   * skipped upstream (caller uses the returned `source` field).
   *
   * Legacy callers may still carry forward or synthesize a scratchpad when
   * `requireApproved` is false. Execution launch always passes
   * `requireApproved: true`, so it can never enter those compatibility paths.
   *
   * Returns `{ path, source }`:
   *   - `canonical_ready`    — plan was approved, content came from canonical
   *   - `carried_forward`    — canonical existed but plan state was not `ready`
   *                            (e.g. legacy plan dir with no metadata state)
   *   - `synthesized`        — no canonical file existed; skeleton generated
   */
  writeScratchpad(
    run: ExecutionRunRecord,
    node: ExecutionDispatchNodePreview,
    options: { requireApproved?: boolean } = {},
  ): { path: string; source: "canonical_ready" | "carried_forward" | "synthesized" } {
    ensurePlanDir(this.artifactRoot, run.work_item_id);
    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
    const metadata = readPlanMetadata(this.artifactRoot, run.work_item_id);

    if (options.requireApproved && metadata?.state !== "ready") {
      throw new BadRequestException(
        `approved_plan_required: work item ${run.work_item_id} has no ready plan metadata`,
      );
    }

    let content: string;
    let source: "canonical_ready" | "carried_forward" | "synthesized";

    if (metadata?.state === "ready") {
      // Step 5 happy path: an approved plan must have a canonical scratchpad.
      if (!existsSync(canonicalPath)) {
        throw new BadRequestException(
          `ready_plan_scratchpad_missing: work item ${run.work_item_id} is marked ready ` +
            `but canonical scratchpad is missing at ${canonicalPath}`,
        );
      }
      content = readFileSync(canonicalPath, "utf8");
      source = "canonical_ready";
    } else if (existsSync(canonicalPath)) {
      // Legacy / fallback: canonical exists but plan is not in `ready` state.
      // Carry the existing plan forward — edits from prior runs survive.
      content = readFileSync(canonicalPath, "utf8");
      source = "carried_forward";
    } else {
      // Fallback: first run for this work item, no canonical exists.
      // Generate a skeleton and persist to canonical.
      content = this.buildScratchpad(run, node);
      writeFileSync(canonicalPath, content, "utf8");
      source = "synthesized";
    }

    const slug = workItemSlug(run.work_item_id);
    const worktreeScratchpad = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    writeFileSync(worktreeScratchpad, content, "utf8");
    return { path: worktreeScratchpad, source };
  }

  // ─── Commit guards ────────────────────────────────────────────────

  /**
   * ADR 014 step 6: detect `SCRATCHPAD_*.md` files currently staged in
   * the worktree's index.
   *
   * Basename match at any path depth. Returns an empty array when the
   * index is clean. Callers use the list both for the rejection error
   * message and for the `scratchpad_commit_blocked` event payload.
   */
  findStagedScratchpadViolations(worktreePath: string): string[] {
    const output = this.worktreeService.runGitIn(worktreePath, ["diff", "--cached", "--name-only"], { allowFailure: true });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && this.isScratchpadPath(line));
  }

  /**
   * ADR 014 step 6: detect `SCRATCHPAD_*.md` files introduced by this
   * branch relative to its base ref.
   *
   * Uses three-dot `$base...HEAD` (merge-base relative) so files that
   * changed on the base branch are not spuriously flagged. This matches
   * what GitHub shows in a pull-request diff.
   */
  findCommittedScratchpadViolations(worktreePath: string, baseRef: string): string[] {
    const output = this.worktreeService.runGitIn(worktreePath, ["diff", "--name-only", `${baseRef}...HEAD`], { allowFailure: true });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && this.isScratchpadPath(line));
  }

  /** Basename match for `SCRATCHPAD_*.md` at any path depth. */
  isScratchpadPath(path: string): boolean {
    return /(?:^|\/)SCRATCHPAD_[^/]*\.md$/.test(path);
  }
}
