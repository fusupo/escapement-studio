import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "../../lib/context-layout.js";
import {
  sanitizeRefinementMetadata,
  sanitizeRehydratedRefinementAnswer,
} from "./refinement-response.js";
import type {
  ActivityLogEntry,
  ChecklistItem,
  ExecutionChecklistSnapshot,
  ExecutionPullRequestRecord,
  ExecutionRefinementState,
  ExecutionRunRecord,
  ExecutionRunPhase,
  ExecutionRunStatus,
  ExecutionSafetyCheck,
  ExecutionTerminalOutcome,
} from "./types.js";

/**
 * Issue #176: pure filesystem helpers for reading and rewriting execution
 * run status files on disk.
 *
 * Separated from ExecutionService / WorkItemReconcilerService so that
 *
 *   (a) reconciler logic stays free of direct filesystem IO, and
 *   (b) the ExecutionService startup rehydration path and the reconciler
 *       both share the same loader / orphan-detector implementation.
 *
 * None of the helpers here are Nest providers — callers construct paths
 * via `runsRoot(artifactRoot)` (from `src/lib/context-layout.ts`) and
 * pass them in directly. This keeps unit tests free of Nest bootstrapping.
 */

const VALID_RUN_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "queued",
  "blocked",
  "preparing",
  "disambiguating",
  "running",
  "completed",
  "error",
]);

const NON_TERMINAL_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "queued",
  "preparing",
  "running",
]);

/**
 * Load every `runs/<id>/status.json` under the given runs root, newest
 * first by `updated_at`. Malformed entries are logged to the supplied
 * `onWarn` hook (or `console.warn` by default) and skipped without
 * throwing — a single broken status file must not kill the whole reconcile
 * pass.
 *
 * studio-87: by default, runs with a non-null `disposed_at` marker are
 * filtered out. This is how `merged_pr → done` close flows remove runs
 * from `ExecutionService.recentRuns` without deleting the artifact dir
 * — disposed runs survive on disk (issue #89 can surface them later)
 * but are hidden from the live recent-runs list and the reconciler.
 * Pass `includeDisposed: true` to include them, e.g. in the close-flow
 * finalizer itself so it can update the marker in place.
 *
 * Returns an empty array when the runs root does not exist.
 */
export function loadRunRecordsFromDisk(
  runsDir: string,
  options: { onWarn?: (message: string) => void; includeDisposed?: boolean } = {},
): ExecutionRunRecord[] {
  if (!existsSync(runsDir)) {
    return [];
  }

  const warn = options.onWarn ?? ((message) => console.warn(`[run-disk-store] ${message}`));
  const records: ExecutionRunRecord[] = [];

  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch (error) {
    warn(`failed to read runs dir ${runsDir}: ${formatError(error)}`);
    return [];
  }

  for (const entry of entries) {
    const runDirPath = join(runsDir, entry);
    const statusPath = join(runDirPath, "status.json");
    if (!existsSync(statusPath)) {
      continue;
    }
    let dirStat;
    try {
      dirStat = statSync(runDirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(statusPath, "utf8");
    } catch (error) {
      warn(`failed to read ${statusPath}: ${formatError(error)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warn(`malformed JSON in ${statusPath}: ${formatError(error)}`);
      continue;
    }

    const record = coerceRecord(parsed);
    if (!record) {
      warn(`status.json at ${statusPath} did not match ExecutionRunRecord shape; skipping`);
      continue;
    }

    // studio-87: hide disposed runs from hydration + reconcile by default.
    // Callers that need to mutate the marker (the close-flow finalizer)
    // can set `includeDisposed: true` to see them.
    if (!options.includeDisposed && record.disposed_at) {
      continue;
    }

    records.push(record);
  }

  records.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return records;
}

/**
 * Convenience wrapper: derive the canonical runs dir from `artifactRoot`
 * and forward to `loadRunRecordsFromDisk`.
 */
export function loadRunRecordsForArtifactRoot(
  artifactRoot: string,
  options: { onWarn?: (message: string) => void; includeDisposed?: boolean } = {},
): ExecutionRunRecord[] {
  return loadRunRecordsFromDisk(runsRoot(artifactRoot), options);
}

export interface OrphanDetectionResult {
  run_id: string;
  previous_status: ExecutionRunStatus;
  rewritten_at: string;
}

/**
 * Scan every run directory under `runsDir` for runs left in a
 * active-agent status (`queued`/`preparing`/`running`)
 * and rewrite them to `error` with an explanatory
 * `activity_log` entry. Idempotent — calling twice is a no-op after the
 * first pass. `disambiguating` is deliberately excluded: refinement sessions
 * end before that durable human gate, so those runs are safe to rehydrate and
 * confirm after a restart.
 *
 * The rewrite uses a write-then-rename flow (`status.json.tmp` → atomic
 * rename) so a crash mid-rewrite leaves the original status.json intact.
 *
 * Returns one entry per rewritten run. Malformed entries, missing
 * status files, and unknown statuses are skipped with a warning.
 */
export function detectAndMarkOrphans(
  runsDir: string,
  options: { now?: () => string; onWarn?: (message: string) => void } = {},
): OrphanDetectionResult[] {
  if (!existsSync(runsDir)) {
    return [];
  }

  const now = options.now ?? (() => new Date().toISOString());
  const warn = options.onWarn ?? ((message) => console.warn(`[run-disk-store] ${message}`));
  const results: OrphanDetectionResult[] = [];

  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch (error) {
    warn(`failed to read runs dir ${runsDir}: ${formatError(error)}`);
    return [];
  }

  for (const entry of entries) {
    const runDirPath = join(runsDir, entry);
    const statusPath = join(runDirPath, "status.json");
    if (!existsSync(statusPath)) {
      continue;
    }
    let dirStat;
    try {
      dirStat = statSync(runDirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(statusPath, "utf8");
    } catch (error) {
      warn(`failed to read ${statusPath}: ${formatError(error)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warn(`malformed JSON in ${statusPath}: ${formatError(error)}`);
      continue;
    }

    const record = coerceRecord(parsed);
    if (!record) {
      warn(`status.json at ${statusPath} did not match ExecutionRunRecord shape; skipping orphan check`);
      continue;
    }

    if (!NON_TERMINAL_STATUSES.has(record.status)) {
      continue;
    }

    const timestamp = now();
    const previousStatus = record.status;
    const orphanEntry: ActivityLogEntry = {
      timestamp,
      kind: "status_change",
      message: `orphaned by server restart at ${timestamp}`,
      detail: `Run was in status "${previousStatus}" when the Studio server restarted. ` +
        `The in-memory AgentSession is gone; the run cannot be resumed. ` +
        `Rewriting to "error" so the reconciler can surface it.`,
    };

    const rewritten: ExecutionRunRecord = {
      ...record,
      status: "error",
      phase: "failed",
      updated_at: timestamp,
      completed_at: record.completed_at ?? timestamp,
      progress_message: `Orphaned by server restart at ${timestamp} (was "${previousStatus}").`,
      result_summary: record.result_summary ?? `Orphaned by server restart at ${timestamp}.`,
      activity_log: [...(record.activity_log ?? []), orphanEntry],
      errors: [
        ...(record.errors ?? []),
        {
          code: "orphaned_by_restart",
          message: `Run was in status "${previousStatus}" when the Studio server restarted and could not be resumed.`,
        },
      ],
    };

    try {
      atomicWriteJson(statusPath, rewritten);
    } catch (error) {
      warn(`failed to rewrite orphan status at ${statusPath}: ${formatError(error)}`);
      continue;
    }

    results.push({ run_id: record.run_id, previous_status: previousStatus, rewritten_at: timestamp });
  }

  return results;
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmpPath, path);
}

/**
 * Runtime guard: the on-disk `status.json` shape must include at least
 * the fields the reconciler and rehydration paths read. We tolerate
 * extra fields (forward compatibility) and missing optional fields by
 * filling them with safe defaults, but a missing `run_id` / `status` /
 * `updated_at` / `branch` / `artifact_dir` is treated as corruption.
 */
/**
 * Shared runtime guard for both live-run hydration and archived-run reads.
 * Exported so issue #89's archive reader reuses the exact same validation
 * semantics as `loadRunRecordsFromDisk`.
 */
export function coerceRecord(raw: unknown): ExecutionRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.run_id !== "string" || !record.run_id) return null;
  if (typeof record.work_item_id !== "string" || !record.work_item_id) return null;
  if (typeof record.status !== "string" || !VALID_RUN_STATUSES.has(record.status as ExecutionRunStatus)) return null;
  if (typeof record.updated_at !== "string" || !record.updated_at) return null;
  if (typeof record.branch !== "string") return null;
  if (typeof record.artifact_dir !== "string") return null;

  const activityLog = Array.isArray(record.activity_log)
    ? record.activity_log.map(coerceActivityLogEntry).filter((entry): entry is ActivityLogEntry => entry != null)
    : [];
  const safetyChecks = Array.isArray(record.safety_checks)
    ? record.safety_checks.map(coerceSafetyCheck).filter((check): check is ExecutionSafetyCheck => check != null)
    : [];
  const changedFiles = Array.isArray(record.changed_files)
    ? record.changed_files.filter((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  const errors = Array.isArray(record.errors)
    ? record.errors.map(coerceRunError).filter((entry): entry is NonNullable<ExecutionRunRecord["errors"]>[number] => entry != null)
    : undefined;
  const pullRequest = coercePullRequestRecord(record.pull_request);
  const terminalOutcome = coerceTerminalOutcome(record.terminal_outcome);
  const phase = coerceRunPhase(record.phase);
  const refinement = coerceRefinement(record.refinement);
  const checklist = coerceChecklist(record.checklist, record.run_id);

  return {
    ...record,
    run_type: "execution",
    work_item_name: (record.work_item_name as string) ?? record.work_item_id as string,
    status: record.status as ExecutionRunStatus,
    phase,
    created_at: (record.created_at as string) ?? (record.updated_at as string),
    base_ref: (record.base_ref as string) ?? "",
    worktree_path: (record.worktree_path as string) ?? "",
    prompt: (record.prompt as string) ?? "",
    repo: typeof record.repo === "string" ? record.repo : null,
    issue_url: typeof record.issue_url === "string" ? record.issue_url : null,
    started_at: typeof record.started_at === "string" ? record.started_at : undefined,
    completed_at: typeof record.completed_at === "string" ? record.completed_at : undefined,
    disposed_at: typeof record.disposed_at === "string" ? record.disposed_at : record.disposed_at === null ? null : undefined,
    session_id: typeof record.session_id === "string" ? record.session_id : undefined,
    progress_message: typeof record.progress_message === "string" ? record.progress_message : undefined,
    result_summary: typeof record.result_summary === "string" ? record.result_summary : undefined,
    terminal_outcome: terminalOutcome,
    refinement,
    checklist,
    activity_log: activityLog,
    safety_checks: safetyChecks,
    changed_files: changedFiles,
    pull_request: pullRequest,
    errors,
  } as ExecutionRunRecord;
}

function coerceChecklist(raw: unknown, runId: string): ExecutionChecklistSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.run_id !== runId
    || !Number.isInteger(value.revision)
    || (value.revision as number) < 1
    || typeof value.updated_at !== "string"
    || Number.isNaN(Date.parse(value.updated_at))
    || !Array.isArray(value.items)
  ) {
    return undefined;
  }

  const categories = new Set(["implementation", "acceptance", "verification"]);
  const items = value.items.flatMap((candidate): ChecklistItem[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.text !== "string"
      || item.text.trim().length === 0
      || typeof item.checked !== "boolean"
      || typeof item.category !== "string"
      || !categories.has(item.category)
    ) {
      return [];
    }
    return [{ text: item.text.trim(), checked: item.checked, category: item.category as ChecklistItem["category"] }];
  });
  const implementationItems = items.filter((item) => item.category === "implementation");
  return {
    run_id: runId,
    revision: value.revision as number,
    updated_at: value.updated_at,
    items,
    completed: implementationItems.filter((item) => item.checked).length,
    total: implementationItems.length,
  };
}

function coerceRunPhase(raw: unknown): ExecutionRunPhase | undefined {
  if (typeof raw !== "string") return undefined;
  const phases: ExecutionRunPhase[] = [
    "queued",
    "preparing",
    "refining_plan",
    "awaiting_confirmation",
    "coding",
    "completed",
    "failed",
    "blocked",
  ];
  return phases.includes(raw as ExecutionRunPhase) ? raw as ExecutionRunPhase : undefined;
}

function coerceRefinement(raw: unknown): ExecutionRefinementState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    !["refining", "awaiting_confirmation", "confirmed"].includes(String(value.status))
    || typeof value.started_at !== "string"
    || !Array.isArray(value.items)
  ) {
    return undefined;
  }
  const items = value.items.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.id !== "string"
      || (item.kind !== "question" && item.kind !== "blocker")
      || typeof item.prompt !== "string"
    ) {
      return [];
    }
    const kind = item.kind as "question" | "blocker";
    const response = typeof item.response === "string" ? item.response : item.response === null ? null : undefined;
    const metadata = sanitizeRefinementMetadata(item, kind);
    if (!metadata) {
      const legacyItem = { id: item.id, kind, prompt: item.prompt, response };
      return [{
        ...legacyItem,
        ...sanitizeRehydratedRefinementAnswer(legacyItem),
      }];
    }

    const structuredItem = {
      id: item.id,
      kind,
      prompt: item.prompt,
      ...metadata,
      selected_option_id: typeof item.selected_option_id === "string" ? item.selected_option_id : null,
      response,
    };
    return [{
      ...structuredItem,
      ...sanitizeRehydratedRefinementAnswer(structuredItem),
    }];
  });
  return {
    status: value.status as ExecutionRefinementState["status"],
    items,
    started_at: value.started_at,
    refined_at: typeof value.refined_at === "string" ? value.refined_at : value.refined_at === null ? null : undefined,
    confirmed_at: typeof value.confirmed_at === "string" ? value.confirmed_at : value.confirmed_at === null ? null : undefined,
    additional_context: typeof value.additional_context === "string"
      ? value.additional_context
      : value.additional_context === null ? null : undefined,
    confirmed_with_unresolved: value.confirmed_with_unresolved === true,
  };
}

function coerceActivityLogEntry(raw: unknown): ActivityLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.timestamp !== "string" || typeof entry.kind !== "string" || typeof entry.message !== "string") {
    return null;
  }
  return {
    timestamp: entry.timestamp,
    kind: entry.kind as ActivityLogEntry["kind"],
    message: entry.message,
    detail: typeof entry.detail === "string" ? entry.detail : undefined,
  };
}

function coerceSafetyCheck(raw: unknown): ExecutionSafetyCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const check = raw as Record<string, unknown>;
  if (typeof check.code !== "string" || typeof check.status !== "string" || typeof check.message !== "string") {
    return null;
  }
  if (check.status !== "pass" && check.status !== "warn" && check.status !== "fail") {
    return null;
  }
  return {
    code: check.code,
    status: check.status,
    message: check.message,
  };
}

function coerceRunError(raw: unknown): NonNullable<ExecutionRunRecord["errors"]>[number] | null {
  if (!raw || typeof raw !== "object") return null;
  const error = raw as Record<string, unknown>;
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    return null;
  }
  return { code: error.code, message: error.message };
}

function coerceTerminalOutcome(raw: unknown): ExecutionTerminalOutcome | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const outcome = raw as Record<string, unknown>;
  if (
    typeof outcome.code !== "string"
    || typeof outcome.severity !== "string"
    || typeof outcome.label !== "string"
    || typeof outcome.detail !== "string"
    || typeof outcome.changed_file_count !== "number"
    || typeof outcome.summary_present !== "boolean"
  ) {
    return undefined;
  }
  if (
    !["success", "no_changes", "missing_summary", "no_changes_and_missing_summary"].includes(outcome.code)
    || !["success", "warn"].includes(outcome.severity)
  ) {
    return undefined;
  }
  return {
    code: outcome.code as ExecutionTerminalOutcome["code"],
    severity: outcome.severity as ExecutionTerminalOutcome["severity"],
    label: outcome.label,
    detail: outcome.detail,
    changed_file_count: outcome.changed_file_count,
    summary_present: outcome.summary_present,
  };
}

function coercePullRequestRecord(raw: unknown): ExecutionPullRequestRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.number !== "number" ||
    typeof record.url !== "string" ||
    typeof record.title !== "string" ||
    typeof record.body !== "string" ||
    typeof record.base_ref !== "string" ||
    typeof record.head_ref !== "string" ||
    typeof record.is_draft !== "boolean" ||
    typeof record.created_at !== "string"
  ) {
    return undefined;
  }
  return {
    number: record.number,
    url: record.url,
    title: record.title,
    body: record.body,
    base_ref: record.base_ref,
    head_ref: record.head_ref,
    is_draft: record.is_draft,
    created_at: record.created_at,
    state: typeof record.state === "string" ? record.state : undefined,
    merged_at: typeof record.merged_at === "string" || record.merged_at === null ? record.merged_at : undefined,
    merge_commit_sha: typeof record.merge_commit_sha === "string" || record.merge_commit_sha === null ? record.merge_commit_sha : undefined,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
