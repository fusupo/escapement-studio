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
 * Issue #86: the terminal execution run statuses eligible for archival.
 *
 * `completed`, `error`, and `blocked` are the three terminal statuses
 * `ExecutionRunStatus` can reach. `queued | preparing | disambiguating
 * | running` runs are refused by the pre-archive active-run guard.
 */
export type ArchivableRunStatus = Extract<ExecutionRunStatus, "completed" | "error" | "blocked">;
