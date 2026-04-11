import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveDir, archivesRoot, runsRoot } from "../../lib/context-layout.js";
import { loadRunRecordsFromDisk } from "./run-disk-store.js";
import type {
  ArchivableRunStatus,
  ArchiveRunArtifactsResult,
  ExecutionPullRequestRecord,
  ExecutionRunRecord,
  ExecutionRunStatus,
} from "./types.js";
import type { WorkItemRecord } from "../graph/types.js";

/**
 * Issue #86: pure filesystem helpers for archiving completed execution run
 * artifacts + a generated README for a work item.
 *
 * Mirrors `run-disk-store.ts`: no Nest imports, trivially unit-testable with
 * a real `mkdtempSync` context root. The helper is imported by
 * `ExecutionService.archiveRunArtifacts` (the thin Nest wrapper used by
 * #88's disposition wiring) and by the dedicated test file.
 *
 * Path construction flows through `archiveDir` / `archivesRoot` / `runsRoot`
 * in `src/lib/context-layout.ts` \u2014 the single source of truth for context-
 * root layout per ADR 014 step 1. Run discovery uses
 * `loadRunRecordsFromDisk` so archival is not capped at the 16-entry
 * in-memory `recentRuns` buffer on `ExecutionService`.
 */

const TERMINAL_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "completed",
  "error",
  "blocked",
]);

const ACTIVE_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "queued",
  "preparing",
  "disambiguating",
  "running",
]);

function isTerminal(status: ExecutionRunStatus): status is ArchivableRunStatus {
  return TERMINAL_STATUSES.has(status);
}

export interface ArchiveRunArtifactsOptions {
  /**
   * Optional injected logger hook. Defaults to `console.warn` with a
   * `[run-archiver]` prefix so tests can assert without real IO.
   */
  onWarn?: (message: string) => void;
  /**
   * Optional clock hook so tests can pin the archive timestamp written to
   * the README. Defaults to `new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * Optional pre-loaded run records for the work item. Supplied by the
   * `ExecutionService` wrapper so it can reuse the same disk scan the
   * active-run guard consumed. When absent the archiver re-reads disk via
   * `loadRunRecordsFromDisk(runsRoot(artifactRoot))` and filters to the
   * target work item.
   */
  runs?: ExecutionRunRecord[];
  /**
   * Optional pull request metadata to include in the README preamble.
   * Defaults to `work_item.meta.studio_post_merge_sync.pull_request` when
   * that shape is present.
   */
  pullRequest?: ExecutionPullRequestRecord | null;
}

/**
 * Core archival entry point.
 *
 * Order of operations (matches the #86 acceptance criteria):
 *
 *   1. Short-circuit if any run for the work item is non-terminal \u2014 the
 *      guard runs BEFORE any filesystem mutation so a refused archive
 *      leaves the context root untouched. Raises `archive_run_active` with
 *      the offending run id.
 *   2. Ensure `archives/<slug>/runs/` exists (creating `archivesRoot`,
 *      `archives/<slug>/`, and `archives/<slug>/runs/` as needed).
 *   3. Iterate terminal runs in `updated_at`-descending order and
 *      `renameSync` each `runs/<run_id>/` into
 *      `archives/<slug>/runs/<run_id>/`. A destination collision raises
 *      `archive_already_exists_run` \u2014 earlier moves are NOT rolled back
 *      (operators must resolve the partial archive manually).
 *   4. Render the README from the in-memory run records captured BEFORE
 *      the move so the metadata survives the source dir vanishing.
 *
 * Returns an `ArchiveRunArtifactsResult` so callers can persist / report
 * the outcome. A no-op (no runs on disk for the work item) still writes a
 * README describing the empty bundle so future forensic readers have a
 * landing point.
 */
export function archiveRunArtifactsForWorkItem(
  artifactRoot: string,
  workItem: WorkItemRecord,
  options: ArchiveRunArtifactsOptions = {},
): ArchiveRunArtifactsResult {
  const warn = options.onWarn ?? ((message) => console.warn(`[run-archiver] ${message}`));
  const now = options.now ?? (() => new Date().toISOString());

  // Gather candidate runs. Prefer the caller-supplied list so a single
  // disk scan can be shared between the active-run guard and the archiver.
  const allRuns = options.runs ?? loadRunRecordsFromDisk(runsRoot(artifactRoot), { onWarn: warn });
  const workItemRuns = allRuns.filter((run) => run.work_item_id === workItem.id);

  // Guard 1: active run short-circuit. Raised BEFORE any filesystem
  // mutation so a refused archive leaves the context root untouched.
  for (const run of workItemRuns) {
    if (ACTIVE_STATUSES.has(run.status)) {
      throw new Error(
        `archive_run_active: refusing to archive work item ${workItem.id} \u2014 run ${run.run_id} is ${run.status}. ` +
          `Wait for it to finish or clean it up before archiving.`,
      );
    }
  }

  const targetArchiveDir = archiveDir(artifactRoot, workItem.id);
  const targetRunsDir = join(targetArchiveDir, "runs");
  const terminalRuns = workItemRuns.filter((run) => isTerminal(run.status));
  const skippedNonTerminal = workItemRuns.filter((run) => !isTerminal(run.status));

  if (workItemRuns.length === 0) {
    warn(
      `no runs found for work item ${workItem.id}; writing README-only archive bundle at ${targetArchiveDir}`,
    );
  }

  // Ensure `archives/`, `archives/<slug>/`, and `archives/<slug>/runs/`
  // exist before the first move. `mkdirSync({ recursive: true })` is a
  // no-op when the dirs already exist (e.g. a prior plan-dir archive
  // already populated `archives/<slug>/`).
  mkdirSync(archivesRoot(artifactRoot), { recursive: true });
  mkdirSync(targetArchiveDir, { recursive: true });
  mkdirSync(targetRunsDir, { recursive: true });

  const archivedRunIds: string[] = [];
  const skippedRunIds: Array<{ run_id: string; reason: string }> = skippedNonTerminal.map((run) => ({
    run_id: run.run_id,
    reason: `not_terminal:${run.status}`,
  }));

  for (const run of terminalRuns) {
    const sourceDir = join(runsRoot(artifactRoot), run.run_id);
    const destDir = join(targetRunsDir, run.run_id);

    if (!existsSync(sourceDir)) {
      warn(
        `archiveRunArtifactsForWorkItem: source ${sourceDir} missing for run ${run.run_id}; skipping move`,
      );
      skippedRunIds.push({ run_id: run.run_id, reason: "source_missing" });
      continue;
    }

    if (existsSync(destDir)) {
      throw new Error(
        `archive_already_exists_run: refusing to move run ${run.run_id} \u2014 destination ${destDir} already exists. ` +
          `Resolve the collision manually before retrying.`,
      );
    }

    renameSync(sourceDir, destDir);
    archivedRunIds.push(run.run_id);
  }

  // Render README AFTER the moves so the `archives/<slug>/runs/<run_id>/`
  // paths in the markdown reflect the final on-disk layout. Metadata
  // comes from the in-memory run records captured before the move.
  const readmePath = join(targetArchiveDir, "README.md");
  const readme = renderArchiveReadme(workItem, terminalRuns, {
    archivePath: targetArchiveDir,
    archivedRunIds,
    skippedRunIds,
    archivedAt: now(),
    pullRequest: options.pullRequest ?? extractPullRequestFromWorkItemMeta(workItem),
  });
  writeFileSync(readmePath, readme, "utf8");

  return {
    work_item_id: workItem.id,
    archive_path: targetArchiveDir,
    readme_path: readmePath,
    archived_run_ids: archivedRunIds,
    skipped_run_ids: skippedRunIds,
  };
}

export interface RenderArchiveReadmeContext {
  archivePath: string;
  archivedRunIds: string[];
  skippedRunIds: Array<{ run_id: string; reason: string }>;
  archivedAt: string;
  pullRequest: ExecutionPullRequestRecord | null;
}

/**
 * Render the `archives/<slug>/README.md` body.
 *
 * Content (in order):
 *   1. Title + work item id / name / kind / repo / issue link
 *   2. Final state + archive timestamp + archive path
 *   3. Optional PR block (number / url / state / merged_at / merge_commit_sha)
 *   4. Per-run section with run_id, status, branch, base_ref, timestamps,
 *      changed-file count, truncated result_summary, and the archived
 *      path under `runs/<run_id>/`.
 *   5. Optional skipped-runs section for non-terminal or collision-skipped runs.
 *   6. Cross-links to the archived scratchpad + metadata.json if they exist
 *      in the archive dir (plan-dir archival may have run first).
 */
export function renderArchiveReadme(
  workItem: WorkItemRecord,
  runs: ExecutionRunRecord[],
  ctx: RenderArchiveReadmeContext,
): string {
  const lines: string[] = [];
  const issueLink = workItem.issue_url ? `[#${workItem.issue_number ?? "?"}](${workItem.issue_url})` : "n/a";

  lines.push(`# Archive: ${workItem.id} \u2014 ${workItem.name}`);
  lines.push("");
  lines.push(`> Auto-generated by \`archiveRunArtifactsForWorkItem\` (issue #86).`);
  lines.push("");
  lines.push("## Work item");
  lines.push("");
  lines.push(`- **id:** \`${workItem.id}\``);
  lines.push(`- **name:** ${workItem.name}`);
  lines.push(`- **kind:** ${workItem.kind}`);
  lines.push(`- **state:** ${workItem.state}`);
  lines.push(`- **repo:** ${workItem.repo ?? "n/a"}`);
  lines.push(`- **issue:** ${issueLink}`);
  lines.push(`- **branch:** ${workItem.branch ?? "n/a"}`);
  lines.push(`- **archived_at:** ${ctx.archivedAt}`);
  lines.push(`- **archive_path:** \`${ctx.archivePath}\``);
  lines.push("");

  if (ctx.pullRequest) {
    lines.push("## Pull request");
    lines.push("");
    lines.push(`- **number:** #${ctx.pullRequest.number}`);
    lines.push(`- **url:** ${ctx.pullRequest.url}`);
    lines.push(`- **title:** ${ctx.pullRequest.title}`);
    lines.push(`- **base_ref:** ${ctx.pullRequest.base_ref}`);
    lines.push(`- **head_ref:** ${ctx.pullRequest.head_ref}`);
    if (ctx.pullRequest.state) lines.push(`- **state:** ${ctx.pullRequest.state}`);
    if (ctx.pullRequest.merged_at) lines.push(`- **merged_at:** ${ctx.pullRequest.merged_at}`);
    if (ctx.pullRequest.merge_commit_sha) lines.push(`- **merge_commit_sha:** \`${ctx.pullRequest.merge_commit_sha}\``);
    lines.push("");
  }

  lines.push("## Archived runs");
  lines.push("");
  if (runs.length === 0) {
    lines.push("_No terminal runs on disk when this archive was created._");
    lines.push("");
  } else {
    for (const run of runs) {
      const archivedHere = ctx.archivedRunIds.includes(run.run_id);
      lines.push(`### Run \`${run.run_id}\``);
      lines.push("");
      lines.push(`- **status:** ${run.status}`);
      lines.push(`- **branch:** ${run.branch}`);
      lines.push(`- **base_ref:** ${run.base_ref}`);
      lines.push(`- **created_at:** ${run.created_at}`);
      if (run.started_at) lines.push(`- **started_at:** ${run.started_at}`);
      if (run.completed_at) lines.push(`- **completed_at:** ${run.completed_at}`);
      lines.push(`- **changed_file_count:** ${run.changed_files?.length ?? 0}`);
      if (run.pull_request) {
        lines.push(`- **pull_request:** #${run.pull_request.number} (${run.pull_request.url})`);
      }
      lines.push(
        archivedHere
          ? `- **archived_at:** \`runs/${run.run_id}/\` (moved into this bundle)`
          : `- **archived_at:** _source missing at archive time_`,
      );
      if (run.result_summary) {
        const truncated = run.result_summary.length > 480
          ? `${run.result_summary.slice(0, 480)}\u2026`
          : run.result_summary;
        lines.push("");
        lines.push("**Result summary:**");
        lines.push("");
        lines.push("```");
        lines.push(truncated);
        lines.push("```");
      }
      lines.push("");
    }
  }

  if (ctx.skippedRunIds.length > 0) {
    lines.push("## Skipped runs");
    lines.push("");
    for (const skipped of ctx.skippedRunIds) {
      lines.push(`- \`${skipped.run_id}\` \u2014 ${skipped.reason}`);
    }
    lines.push("");
  }

  const planDirNotes = describePreservedPlanDir(ctx.archivePath);
  if (planDirNotes.length > 0) {
    lines.push("## Plan artifacts");
    lines.push("");
    for (const note of planDirNotes) lines.push(note);
    lines.push("");
  }

  lines.push("## Notes");
  lines.push("");
  lines.push("- Move semantics: run dirs are `fs.renameSync`\u2019d from `runs/<run_id>/` into this bundle; source dirs no longer exist after archival.");
  lines.push("- See [ADR 014](../../docs/adr/014-plans-runs-state-model.md) and [docs/contracts/run-artifacts.md](../../docs/contracts/run-artifacts.md) for the archive layout contract.");
  lines.push("");

  return lines.join("\n");
}

/**
 * If plan-dir archival ran first (common path via
 * `archiveAndCloseMergedPullRequest`), the archive dir will already
 * contain `SCRATCHPAD_<slug>.md` and `metadata.json`. Surface them as
 * cross-links in the README so forensic readers can find them.
 *
 * Silent no-op when the archive dir is empty apart from `runs/`.
 */
function describePreservedPlanDir(archivePathAbs: string): string[] {
  const notes: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(archivePathAbs);
  } catch {
    return notes;
  }
  for (const entry of entries) {
    if (entry === "runs" || entry === "README.md") continue;
    if (entry === "metadata.json") {
      notes.push("- `metadata.json` \u2014 plan metadata preserved from the `plans/<slug>/` archival.");
      continue;
    }
    if (entry.startsWith("SCRATCHPAD_") && entry.endsWith(".md")) {
      notes.push(`- \`${entry}\` \u2014 canonical scratchpad preserved from the \`plans/<slug>/\` archival.`);
      continue;
    }
    notes.push(`- \`${entry}\` \u2014 preserved from an earlier archive step.`);
  }
  return notes;
}

/**
 * Pull the `pull_request` block out of
 * `work_item.meta.studio_post_merge_sync.pull_request` when present. That
 * shape is written by `ExecutionService.syncMergedPullRequest` during the
 * `open_pr \u2192 merged_pr` transition. Returns `null` when the shape is
 * missing or malformed \u2014 the README simply omits the PR section in that
 * case.
 */
function extractPullRequestFromWorkItemMeta(workItem: WorkItemRecord): ExecutionPullRequestRecord | null {
  const meta = workItem.meta ?? {};
  const sync = (meta as Record<string, unknown>).studio_post_merge_sync;
  if (!sync || typeof sync !== "object") return null;
  const pr = (sync as Record<string, unknown>).pull_request;
  if (!pr || typeof pr !== "object") return null;
  const candidate = pr as Partial<ExecutionPullRequestRecord>;
  if (typeof candidate.number !== "number" || typeof candidate.url !== "string") return null;
  return {
    number: candidate.number,
    url: candidate.url,
    title: typeof candidate.title === "string" ? candidate.title : "",
    body: typeof candidate.body === "string" ? candidate.body : "",
    base_ref: typeof candidate.base_ref === "string" ? candidate.base_ref : "",
    head_ref: typeof candidate.head_ref === "string" ? candidate.head_ref : "",
    is_draft: Boolean(candidate.is_draft),
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : "",
    state: typeof candidate.state === "string" ? candidate.state : undefined,
    merged_at: typeof candidate.merged_at === "string" ? candidate.merged_at : null,
    merge_commit_sha: typeof candidate.merge_commit_sha === "string" ? candidate.merge_commit_sha : null,
  };
}
