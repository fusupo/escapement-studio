export type ExecutionRunStatus = "queued" | "blocked" | "preparing" | "disambiguating" | "running" | "completed" | "error";
export type ExecutionSafetyStatus = "pass" | "warn" | "fail";
export type ActivityLogEntryKind = "status_change" | "tool_start" | "tool_end" | "turn_start" | "turn_end" | "reasoning" | "error" | "info" | "follow_up" | "agent_message" | "user_message";

export interface ActivityLogEntry {
  timestamp: string;
  kind: ActivityLogEntryKind;
  message: string;
  detail?: string;
}

export interface ExecutionSafetyCheck {
  code: string;
  status: ExecutionSafetyStatus;
  message: string;
}

export interface ExecutionDispatchNodePreview {
  id: string;
  name: string;
  repo: string | null;
  branch: string;
  issue_url?: string;
  scope_hint?: string | null;
  default_base_ref: string;
  files_owned: string[];
  files_shared: Array<{
    path: string;
    assessment: string;
    confidence: string;
    notes: string;
  }>;
  files_forbidden: string[];
  worktree_path: string;
  safety_checks: ExecutionSafetyCheck[];
  can_launch: boolean;
  issue_backed: boolean;
  launch_unavailable_code?: string | null;
  launch_unavailable_reason?: string | null;
}

export interface ExecutionLaunchEligibility {
  work_item_id: string;
  repo: string | null;
  issue_url: string | null;
  issue_backed: boolean;
  can_launch: boolean;
  safety_checks: ExecutionSafetyCheck[];
  launch_unavailable_code: string | null;
  launch_unavailable_reason: string | null;
  dispatch_node: ExecutionDispatchNodePreview | null;
}

export interface ExecutionDispatchGroupPreview {
  group_id: string;
  repo: string;
  merge_order?: string[];
  nodes: ExecutionDispatchNodePreview[];
}

export interface ExecutionDispatchPreview {
  generated_at: string;
  assumptions: string[];
  validation_policy: {
    max_concurrent_node_heavy_tasks: number;
    serialized_checks: string[];
  };
  summary: {
    frontier_count: number;
    dispatchable_now: number;
    blocked_count: number;
    human_gate_count: number;
  };
  groups: ExecutionDispatchGroupPreview[];
  blocked: Array<{
    id: string;
    name: string;
    blocked_by: string[];
    reason: string;
  }>;
}

export interface LaunchExecutionRunDto {
  work_item_id: string;
  base_ref?: string;
  prompt?: string;
  /** When true, run a Q&A disambiguation phase before coding starts. Default: true */
  disambiguate?: boolean;
}

export interface ExecutionRunRecord {
  run_id: string;
  run_type: "execution";
  work_item_id: string;
  work_item_name: string;
  status: ExecutionRunStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  /**
   * studio-87: ISO timestamp set when a run is disposed as part of a
   * `merged_pr → done` close flow. Runs with a non-null `disposed_at`
   * are filtered out of `ExecutionService.recentRuns` hydration and the
   * recent-runs list in the UI, but the on-disk `runs/<id>/` dir is
   * preserved so issue #89 (archived execution run history) can surface
   * it later. Absent / null on all live runs.
   */
  disposed_at?: string | null;
  repo?: string | null;
  issue_url?: string | null;
  branch: string;
  base_ref: string;
  worktree_path: string;
  artifact_dir: string;
  session_id?: string;
  prompt: string;
  progress_message?: string;
  result_summary?: string;
  activity_log: ActivityLogEntry[];
  changed_files?: string[];
  pull_request?: ExecutionPullRequestRecord;
  safety_checks: ExecutionSafetyCheck[];
  errors?: Array<{ code: string; message: string }>;
}

export interface LaunchExecutionRunResult {
  accepted: boolean;
  run: ExecutionRunRecord;
}

export interface ExecutionPullRequestRecord {
  number: number;
  url: string;
  title: string;
  body: string;
  base_ref: string;
  head_ref: string;
  is_draft: boolean;
  created_at: string;
  state?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
}

export interface CreateExecutionPullRequestDto {
  run_id: string;
  title?: string;
  body?: string;
  base_ref?: string;
  draft?: boolean;
  auto_commit?: boolean;
  commit_message?: string;
}

export interface CreateExecutionPullRequestResult {
  run: ExecutionRunRecord;
  pull_request: ExecutionPullRequestRecord;
}

export interface CleanupWorktreeDto {
  run_id: string;
}

export interface CleanupWorktreeResult {
  run_id: string;
  branch: string;
  worktree_path: string;
  worktree_removed: boolean;
  branch_removed: boolean;
}

export interface SyncMergedExecutionDto {
  work_item_id: string;
  pull_request_number?: number;
  actual_files?: string[];
  archive_path?: string | null;
  branch?: string | null;
  stage_github_sync?: boolean;
}

export interface SyncMergedExecutionResult {
  synced: true;
  work_item: {
    id: string;
    state: string;
    branch: string | null;
    archive_path: string | null;
    actual_files: string[];
    meta: Record<string, unknown>;
    updated_at: string;
  };
  pull_request: ExecutionPullRequestRecord;
  matched_run_id: string | null;
  actual_files_source: "input" | "work_item" | "run";
  dispatch_preview: ExecutionDispatchPreview;
  managed_block_sync?: {
    work_item_id: string;
    based_on_body_hash: string;
    operations: Array<{
      id: string;
      kind: string;
      summary: string;
      rationale: string;
      target: {
        repo: string;
        issue_number: number;
        work_item_id: string;
      };
      preview: {
        before: string;
        after: string;
      };
    }>;
  } | null;
  cleanup: CleanupWorktreeResult | null;
}

export interface ExecutionStatusEvent {
  run: ExecutionRunRecord;
}

export interface FollowUpMessageDto {
  run_id: string;
  message: string;
  /** "steer" interrupts the current turn; "followUp" waits for the current turn to finish. Default: "followUp" */
  delivery?: "steer" | "followUp";
}

export interface FollowUpMessageResult {
  accepted: boolean;
  run_id: string;
  delivery: "steer" | "followUp" | "new_turn";
  message: string;
  error?: string;
}

export interface RunChatHistory {
  run_id: string;
  messages: RunChatMessage[];
}

export interface RunChatMessage {
  timestamp: string;
  role: "user" | "assistant";
  text: string;
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
}

export interface ExecutionChecklistSnapshot {
  run_id: string;
  items: ChecklistItem[];
  completed: number;
  total: number;
}

export interface ResolveDisambiguationDto {
  run_id: string;
  /** Optional additional context or answers to pass to the coding agent when it starts. */
  additional_context?: string;
}

export interface ResolveDisambiguationResult {
  resolved: boolean;
  run_id: string;
  /** Present when resolved is false */
  error?: string;
}

/**
 * ADR 014 step 5: request payload for the in_progress → {ready,drafting}
 * transition endpoints. Operator triggers these after a run fails or is
 * abandoned to advance the work item back to a plan-editable state.
 */
export interface TransitionWorkItemDto {
  work_item_id: string;
}

/**
 * studio-87: summary of a GitHub issue closed as part of the merged-PR
 * close flow. Populated when the work item is issue-backed (kind=issue,
 * issue_number present) and `gh issue close` completed successfully.
 */
export interface ClosedGitHubIssueSummary {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
}

/**
 * studio-87: result envelope for `POST /api/execution/close-merged`.
 *
 * The endpoint now owns the full orchestration (close GitHub issue →
 * transition work item → dispose matching recent runs) so the caller
 * can reflect the combined outcome in one round trip.
 *
 * Fields:
 * - `work_item` — the updated work item record (state=done).
 * - `closed_issue` — the closed GitHub issue details, or null when the
 *   work item is not issue-backed or the issue was already closed.
 * - `removed_run_ids` — ids of runs spliced out of recentRuns and
 *   marked `disposed_at` on disk. Empty when no run was matched.
 * - `dispatch_preview` — post-close dispatch preview so the execution
 *   panel can refresh without an extra round trip. Mirrors the shape
 *   returned by `syncMergedPullRequest`.
 */
export interface CloseMergedPullRequestResult {
  work_item: {
    id: string;
    state: string;
    branch: string | null;
    archive_path: string | null;
    actual_files: string[];
    meta: Record<string, unknown>;
    updated_at: string;
  };
  closed_issue: ClosedGitHubIssueSummary | null;
  removed_run_ids: string[];
  dispatch_preview: ExecutionDispatchPreview;
}

/**
 * Issue #86: result of archiving execution run artifacts + generated
 * summary for a completed work item.
 *
 * Produced by `archiveRunArtifactsForWorkItem` and surfaced through the
 * thin `ExecutionService.archiveRunArtifacts` wrapper. Callers (currently
 * #88's disposition wiring) persist `archive_path` onto the work item and
 * report `archived_run_ids` / `skipped_run_ids` back to operators.
 *
 * - `archive_path` is the `archives/<slug>/` directory that contains the
 *   moved run dirs and the generated `README.md`.
 * - `readme_path` is the absolute path to the written README (may equal
 *   `<archive_path>/README.md`). `null` when no README was written — e.g.
 *   a no-op archive with zero runs to move.
 * - `archived_run_ids` lists every run successfully moved into the
 *   archive bundle, in the order they were processed.
 * - `skipped_run_ids` records per-run reasons for runs the helper chose
 *   not to move (currently only `not_terminal` — the active-run guard
 *   short-circuits before any run is inspected, so active runs never
 *   show up here).
 */
export interface ArchiveRunArtifactsResult {
  work_item_id: string;
  archive_path: string;
  readme_path: string | null;
  archived_run_ids: string[];
  skipped_run_ids: Array<{ run_id: string; reason: string }>;
}

/**
 * Issue #89: compact per-run summary surfaced from an archived bundle.
 *
 * Derived from archived `runs/<run_id>/status.json` files and narrowed to
 * the fields the archived-runs UI needs. `result_summary` is truncated by
 * the archive reader so list/detail payloads stay small.
 */
export interface ArchivedRunSummary {
  run_id: string;
  status: ExecutionRunStatus;
  branch: string;
  base_ref: string;
  created_at: string;
  completed_at?: string;
  changed_file_count: number;
  result_summary?: string;
  pull_request?: ExecutionPullRequestRecord;
  archived_run_dir: string;
}

/**
 * Issue #89: read-only archived bundle surfaced by the execution archive
 * list/detail endpoints.
 *
 * `readme_content` is omitted from list responses and included by the
 * detail endpoint only.
 */
export interface ArchivedRunBundle {
  work_item_id: string;
  work_item_name: string;
  slug: string;
  archive_path: string;
  readme_path: string | null;
  readme_exists: boolean;
  readme_content?: string | null;
  archived_at: string;
  pull_request?: ExecutionPullRequestRecord | null;
  runs: ArchivedRunSummary[];
  plan_artifacts?: {
    scratchpad_filename?: string;
    metadata_filename?: string;
  };
}

/**
 * studio-88: persisted audit trail written to `work_item.meta.studio_archive`
 * when `archiveAndCloseMergedPullRequest` completes successfully.
 *
 * Mirrors the shape of `work_item.meta.studio_post_merge_sync` so both
 * blocks can be shallow-merged into `meta` without colliding. Downstream
 * consumers (archived-run-history UIs, post-hoc forensics) read this
 * block to recover `archives/<slug>/` pointers without re-scanning disk.
 *
 * Fields:
 * - `archived_at` — ISO timestamp the archive orchestration completed.
 * - `readme_path` — absolute path to the README written inside
 *   `archives/<slug>/`, or `null` when no README was written.
 * - `archived_run_ids` — run ids moved into the archive bundle in order.
 * - `skipped_run_ids` — per-run reasons the archiver refused to move
 *   the run (e.g. `not_terminal:<status>`, `source_missing`).
 */
export interface StudioArchiveMeta {
  archived_at: string;
  readme_path: string | null;
  archived_run_ids: string[];
  skipped_run_ids: Array<{ run_id: string; reason: string }>;
}

/**
 * studio-88: result envelope for `POST /api/execution/archive-and-close-merged`.
 *
 * Extends the `CloseMergedPullRequestResult` shape with an additional
 * `archive` block carrying the fields from `ArchiveRunArtifactsResult`
 * (archive_path / readme_path / archived_run_ids / skipped_run_ids) so the
 * frontend can surface archive counts + paths without issuing a follow-up
 * request.
 *
 * Fields:
 * - `work_item` — the updated work item record (state=done,
 *   archive_path populated, meta.studio_archive block present).
 * - `closed_issue` — closed GitHub issue details, or null when the work
 *   item is not issue-backed.
 * - `removed_run_ids` — ids of runs spliced out of `recentRuns` and
 *   stamped `disposed_at` on disk. Empty when no run was matched.
 * - `archive` — archive step result (path + readme + archived + skipped).
 * - `dispatch_preview` — post-close dispatch preview for a single round trip.
 */
export interface ArchiveAndCloseMergedPullRequestResult {
  work_item: {
    id: string;
    state: string;
    branch: string | null;
    archive_path: string | null;
    actual_files: string[];
    meta: Record<string, unknown>;
    updated_at: string;
  };
  closed_issue: ClosedGitHubIssueSummary | null;
  removed_run_ids: string[];
  archive: {
    archive_path: string;
    readme_path: string | null;
    archived_run_ids: string[];
    skipped_run_ids: Array<{ run_id: string; reason: string }>;
  };
  dispatch_preview: ExecutionDispatchPreview;
}

/**
 * studio-88: persisted audit trail written to `work_item.meta.studio_archive`
 * when `archiveAndCloseMergedPullRequest` completes successfully.
 *
 * Mirrors the shape of `work_item.meta.studio_post_merge_sync` so both
 * blocks can be shallow-merged into `meta` without colliding. Downstream
 * consumers (archived-run-history UIs, post-hoc forensics) read this
 * block to recover `archives/<slug>/` pointers without re-scanning disk.
 *
 * Fields:
 * - `archived_at` — ISO timestamp the archive orchestration completed.
 * - `readme_path` — absolute path to the README written inside
 *   `archives/<slug>/`, or `null` when no README was written.
 */
export interface ExecutionStudioArchiveRecord {
  archived_at: string;
  readme_path: string | null;
  pull_request?: ExecutionPullRequestRecord | null;
  runs: ArchivedRunSummary[];
  plan_artifacts?: {
    scratchpad_filename?: string;
    metadata_filename?: string;
  };
}

/**
 * Issue #86: the terminal execution run statuses eligible for archival.
 *
 * `completed`, `error`, and `blocked` are the three terminal statuses
 * `ExecutionRunStatus` can reach. `queued | preparing | disambiguating
 * | running` runs are refused by the pre-archive active-run guard.
 */
export type ArchivableRunStatus = Extract<ExecutionRunStatus, "completed" | "error" | "blocked">;
