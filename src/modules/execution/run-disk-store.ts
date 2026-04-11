import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "../../lib/context-layout.js";
import type { ActivityLogEntry, ExecutionRunRecord, ExecutionRunStatus } from "./types.js";

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

const NON_TERMINAL_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "queued",
  "preparing",
  "disambiguating",
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
 * non-terminal status (`queued`/`preparing`/`disambiguating`/`running`)
 * and rewrite them to `error` with an explanatory
 * `activity_log` entry. Idempotent — calling twice is a no-op after the
 * first pass.
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
        `The in-memory AgentSession and disambiguation gate are gone; the run cannot be resumed. ` +
        `Rewriting to "error" so the reconciler can surface it.`,
    };

    const rewritten: ExecutionRunRecord = {
      ...record,
      status: "error",
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
  if (typeof record.status !== "string") return null;
  if (typeof record.updated_at !== "string") return null;
  if (typeof record.branch !== "string") return null;
  if (typeof record.artifact_dir !== "string") return null;

  const activityLog = Array.isArray(record.activity_log) ? (record.activity_log as ActivityLogEntry[]) : [];
  const safetyChecks = Array.isArray(record.safety_checks) ? record.safety_checks : [];

  // Pass through the raw parsed object with required fields verified and
  // defaults filled for list/object fields. The cast is narrowing — we've
  // verified the string fields above and the two array fields here.
  return {
    run_type: (record.run_type as ExecutionRunRecord["run_type"]) ?? "execution",
    work_item_name: (record.work_item_name as string) ?? record.work_item_id as string,
    created_at: (record.created_at as string) ?? (record.updated_at as string),
    base_ref: (record.base_ref as string) ?? "",
    worktree_path: (record.worktree_path as string) ?? "",
    prompt: (record.prompt as string) ?? "",
    ...record,
    activity_log: activityLog,
    safety_checks: safetyChecks as ExecutionRunRecord["safety_checks"],
  } as ExecutionRunRecord;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
