export type ExecutionRunStatus = "queued" | "blocked" | "preparing" | "running" | "completed" | "error";
export type ExecutionSafetyStatus = "pass" | "warn" | "fail";

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
}

export interface CreateExecutionPullRequestResult {
  run: ExecutionRunRecord;
  pull_request: ExecutionPullRequestRecord;
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
}

export interface ExecutionStatusEvent {
  run: ExecutionRunRecord;
}
