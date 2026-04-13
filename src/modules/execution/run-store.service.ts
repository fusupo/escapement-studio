import { Injectable, Logger, MessageEvent } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { loadRunRecordsForArtifactRoot, loadRunRecordsFromDisk } from "./run-disk-store.js";
import type {
  ExecutionDispatchNodePreview,
  ExecutionRunRecord,
  ExecutionStatusEvent,
} from "./types.js";

/**
 * Phase 4a of the cqrs refactor (#230): owns the in-memory run buffer
 * (capped at 16) + every read/write to runs/<id>/status.json,
 * metadata.json, events.jsonl, summary.md + the SSE event stream.
 *
 * Methods lifted verbatim from ExecutionService. The fields
 * (`recentRuns`, `eventSubject`, `eventCounter`, `streamId`,
 * `artifactRoot`) keep the existing names so the
 * `Object.create(...prototype)` test harnesses transplant cleanly.
 *
 * Two new public methods — `disposeRunsForWorkItem` and
 * `captureRunSnapshotForWorkItem` — absorb the Phase 3 seams
 * (`disposeRunsForWorkItemInBuffer` + `emitRunExecutionResult`) plus
 * the disk-scan portion of RunDispositionService.removeRunsForWorkItem.
 *
 * RunStore takes no injected dependencies — all state is either a
 * constant (`recentRunLimit`, `streamId`), computed from
 * `getConfig()` (`artifactRoot`), or internal. This keeps Phase 4
 * coupling minimal and lets tests construct RunStore directly.
 */
@Injectable()
export class RunStore {
  private readonly logger = new Logger(RunStore.name);
  private readonly streamId = "execution-runs";
  private readonly eventSubject = new Subject<MessageEvent>();
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  private readonly recentRuns: ExecutionRunRecord[] = [];
  private readonly recentRunLimit = 16;
  private eventCounter = 0;

  /**
   * Issue #176: populate `recentRuns` from `runs/<id>/status.json` on
   * disk, keeping the most recent `recentRunLimit` entries ordered by
   * `updated_at` descending. Existing in-memory entries are preserved
   * and deduplicated by `run_id` so a second call during tests is a
   * no-op for runs already tracked.
   */
  hydrateRecentRunsFromDisk(): void {
    const loaded = loadRunRecordsForArtifactRoot(this.artifactRoot);
    const existingIds = new Set(this.recentRuns.map((run) => run.run_id));
    for (const run of loaded) {
      if (existingIds.has(run.run_id)) continue;
      this.recentRuns.push(run);
      existingIds.add(run.run_id);
    }
    this.recentRuns.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (this.recentRuns.length > this.recentRunLimit) {
      this.recentRuns.splice(this.recentRunLimit);
    }
  }

  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.eventSubject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  listRecentRuns(): ExecutionRunRecord[] {
    return [...this.recentRuns].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getRun(runId: string): ExecutionRunRecord | null {
    return this.recentRuns.find((run) => run.run_id === runId) ?? null;
  }

  upsertRecentRun(run: ExecutionRunRecord): void {
    const existingIndex = this.recentRuns.findIndex((item) => item.run_id === run.run_id);
    if (existingIndex >= 0) {
      this.recentRuns[existingIndex] = run;
    } else {
      this.recentRuns.unshift(run);
      this.recentRuns.splice(this.recentRunLimit);
    }
  }

  updateRun(runId: string, patch: Partial<ExecutionRunRecord>): ExecutionRunRecord | null {
    const index = this.recentRuns.findIndex((run) => run.run_id === runId);
    if (index === -1) {
      return null;
    }

    const nextRun: ExecutionRunRecord = {
      ...this.recentRuns[index],
      ...patch,
      updated_at: this.now(),
    };
    this.recentRuns[index] = nextRun;
    this.writeStatus(nextRun);
    this.emitRun(
      nextRun.status === "completed" || nextRun.status === "error" || nextRun.status === "blocked"
        ? "execution_result"
        : "execution_status",
      nextRun,
    );
    return nextRun;
  }

  persistRun(run: ExecutionRunRecord): void {
    mkdirSync(run.artifact_dir, { recursive: true });
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    this.upsertRecentRun(run);
    this.writeMetadata(run);
    this.writeStatus(run);
    this.appendEvent(run, { type: "run_created", status: run.status });
    this.emitRun(run.status === "blocked" ? "execution_result" : "execution_status", run);
  }

  writeMetadata(run: ExecutionRunRecord): void {
    writeFileSync(join(run.artifact_dir, "metadata.json"), JSON.stringify({
      run_id: run.run_id,
      run_type: run.run_type,
      created_at: run.created_at,
      work_item_id: run.work_item_id,
      work_item_name: run.work_item_name,
      repo: run.repo,
      issue_url: run.issue_url,
      branch: run.branch,
      base_ref: run.base_ref,
      worktree_path: run.worktree_path,
      artifact_dir: run.artifact_dir,
    }, null, 2), "utf8");
  }

  writeStatus(run: ExecutionRunRecord): void {
    writeFileSync(join(run.artifact_dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
  }

  writeSummary(run: ExecutionRunRecord, node?: ExecutionDispatchNodePreview): void {
    const lines = [
      `# Execution run ${run.run_id}`,
      "",
      `- Work item: ${run.work_item_id} — ${run.work_item_name}`,
      `- Status: ${run.status}`,
      `- Branch: ${run.branch}`,
      `- Base ref: ${run.base_ref}`,
      `- Worktree: ${run.worktree_path}`,
      `- Artifact dir: ${run.artifact_dir}`,
      `- Created: ${run.created_at}`,
      `- Updated: ${run.updated_at}`,
      ...(run.started_at ? [`- Started: ${run.started_at}`] : []),
      ...(run.completed_at ? [`- Completed: ${run.completed_at}`] : []),
      ...(run.pull_request ? [`- Pull request: ${run.pull_request.url}`] : []),
      "",
      "## Safety checks",
      ...run.safety_checks.map((check) => `- [${check.status}] ${check.code}: ${check.message}`),
      "",
      ...(node ? ["## Dispatch scope", ...(node.files_owned.length ? ["Owned files:", ...node.files_owned.map((path) => `- ${path}`)] : ["Owned files: (none predicted)"]), ""] : []),
      "## Result",
      run.result_summary ?? run.progress_message ?? "No summary available.",
      "",
      ...(run.changed_files?.length ? ["## Changed files", ...run.changed_files.map((path) => `- ${path}`), ""] : []),
      ...(run.pull_request ? [
        "## Pull request",
        `- Number: ${run.pull_request.number}`,
        `- URL: ${run.pull_request.url}`,
        `- Draft: ${run.pull_request.is_draft ? "yes" : "no"}`,
        `- Base: ${run.pull_request.base_ref}`,
        `- Head: ${run.pull_request.head_ref}`,
        "",
      ] : []),
    ];

    writeFileSync(join(run.artifact_dir, "summary.md"), lines.join("\n"), "utf8");
  }

  appendEvent(run: ExecutionRunRecord, payload: Record<string, unknown>): void {
    appendFileSync(
      join(run.artifact_dir, "events.jsonl"),
      `${JSON.stringify({ timestamp: this.now(), run_id: run.run_id, ...payload })}\n`,
      "utf8",
    );
  }

  emitRun(eventType: "execution_status" | "execution_result", run: ExecutionRunRecord): void {
    const envelope = {
      event_id: `evt_${++this.eventCounter}`,
      stream_id: this.streamId,
      timestamp: this.now(),
      event_type: eventType,
      session_id: run.run_id,
      turn_id: null,
      payload: { run } satisfies ExecutionStatusEvent,
    };

    this.eventSubject.next({
      type: envelope.event_type,
      data: JSON.stringify(envelope),
      id: envelope.event_id,
    });
  }

  /**
   * Phase 4a: absorbs Phase 3's `disposeRunsForWorkItemInBuffer` +
   * `emitRunExecutionResult` seams AND the disk-scan portion of
   * `RunDispositionService.removeRunsForWorkItem`. Single call does
   * the full disposition:
   *
   *   1. Walk `recentRuns` back-to-front, splicing every match.
   *      Stamp `disposed_at` and `writeStatus` for records that
   *      weren't already disposed; emit execution_result for each.
   *      ENOENT from writeStatus is swallowed (missing status files
   *      are expected after partial failures / restarts).
   *   2. Scan the on-disk `runs/` dir for records not yet in the
   *      buffer (hydration gap / cap eviction). For each un-disposed
   *      match, write a new status.json with `disposed_at` stamped.
   *
   * Returns the full set of run IDs that were disposed — both
   * newly-stamped and already-disposed-but-spliced, plus on-disk
   * records that got stamped.
   *
   * Failures are logged and swallowed; this is a finalizer and the
   * caller has already completed the state transition.
   */
  disposeRunsForWorkItem(workItemId: string, now: () => string): string[] {
    const timestamp = now();
    const removedIds = new Set<string>();

    // (a) In-memory buffer walk.
    for (let i = this.recentRuns.length - 1; i >= 0; i--) {
      const run = this.recentRuns[i];
      if (run.work_item_id !== workItemId) continue;
      if (run.disposed_at) {
        // Already disposed; drop from the buffer but don't re-write.
        this.recentRuns.splice(i, 1);
        removedIds.add(run.run_id);
        continue;
      }
      const disposed: ExecutionRunRecord = {
        ...run,
        disposed_at: timestamp,
        updated_at: timestamp,
      };
      try {
        this.writeStatus(disposed);
      } catch (error) {
        if (!this.isMissingFileError(error)) {
          this.logger.warn(
            `disposeRunsForWorkItem: failed to stamp disposed_at for run ${run.run_id}: ${this.getErrorMessage(error)}`,
          );
        }
      }
      this.recentRuns.splice(i, 1);
      removedIds.add(run.run_id);
      try {
        this.emitRun("execution_result", disposed);
      } catch (error) {
        this.logger.warn(
          `disposeRunsForWorkItem: failed to emit execution_result for run ${run.run_id}: ${this.getErrorMessage(error)}`,
        );
      }
    }

    // (b) On-disk runs that were not in recentRuns (hydration gap /
    //     cap eviction). Pass includeDisposed so we can see
    //     already-disposed records for idempotent replay, but skip
    //     them when writing.
    try {
      const runsDir = join(this.artifactRoot, "runs");
      const diskRuns = loadRunRecordsFromDisk(runsDir, { includeDisposed: true });
      for (const run of diskRuns) {
        if (run.work_item_id !== workItemId) continue;
        if (removedIds.has(run.run_id)) continue;
        if (run.disposed_at) continue;
        const disposed: ExecutionRunRecord = {
          ...run,
          disposed_at: timestamp,
          updated_at: timestamp,
        };
        try {
          writeFileSync(
            join(run.artifact_dir, "status.json"),
            JSON.stringify(disposed, null, 2),
            "utf8",
          );
          removedIds.add(run.run_id);
        } catch (error) {
          if (!this.isMissingFileError(error)) {
            this.logger.warn(
              `disposeRunsForWorkItem: failed to stamp disposed_at for on-disk run ${run.run_id}: ${this.getErrorMessage(error)}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `disposeRunsForWorkItem: failed to scan runs dir: ${this.getErrorMessage(error)}`,
      );
    }

    return Array.from(removedIds);
  }

  /**
   * Phase 4a: merges the in-memory `recentRuns` buffer with the
   * on-disk scan, filtered to one work item, deduped by `run_id`
   * (in-memory wins because it carries the freshest activity log).
   *
   * Used by RunDispositionService's disposition flows to hand the
   * archiver a list that survives the downstream
   * `disposeRunsForWorkItem` finalizer stamping `disposed_at` on
   * each record.
   */
  captureRunSnapshotForWorkItem(workItemId: string): ExecutionRunRecord[] {
    const seen = new Set<string>();
    const merged: ExecutionRunRecord[] = [];
    for (const run of this.listRecentRuns()) {
      if (run.work_item_id !== workItemId) continue;
      if (seen.has(run.run_id)) continue;
      merged.push(run);
      seen.add(run.run_id);
    }
    try {
      const diskRuns = loadRunRecordsForArtifactRoot(this.artifactRoot);
      for (const run of diskRuns) {
        if (run.work_item_id !== workItemId) continue;
        if (seen.has(run.run_id)) continue;
        merged.push(run);
        seen.add(run.run_id);
      }
    } catch (error) {
      this.logger.warn(
        `captureRunSnapshotForWorkItem: failed to scan disk for ${workItemId}: ${this.getErrorMessage(error)}`,
      );
    }
    return merged;
  }

  // Duplicated trivial helpers — Phase 9 can extract to a shared util.

  private now(): string {
    return new Date().toISOString();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isMissingFileError(error: unknown): boolean {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT";
  }
}
