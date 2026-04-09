import type { PlanMetadata } from "../../lib/context-layout.js";

/** POST /api/plans/:work_item_id/prepare — no body required. */
export interface PreparePlanDto {
  // intentionally empty — the work item id is a path param
}

/** POST /api/plans/:work_item_id/approve */
export interface ApprovePlanDto {
  /** Opaque identifier of the approver. Defaults to `"local"` (single-user MVP). */
  approved_by?: string;
}

/** POST /api/plans/:work_item_id/reopen */
export interface ReopenPlanDto {
  /** Optional human-readable reason recorded in plan metadata. Not persisted yet. */
  reason?: string;
}

/**
 * Diff between the current work item's `predicted_files` and the files parsed
 * out of the plan's `## Affected Files` section at approval time.
 */
export interface PredictedFilesDiff {
  /** Files present in the plan but not in the previous `predicted_files`. */
  added: string[];
  /** Files present in the previous `predicted_files` but not in the plan. */
  removed: string[];
  /** Files present in both. */
  unchanged: string[];
}

/**
 * Response shape for all plan endpoints. The scratchpad content is always
 * inlined (matching `getRunScratchpad` in the execution controller).
 */
export interface PlanResponse {
  work_item_id: string;
  metadata: PlanMetadata;
  scratchpad_content: string;
  /** Set on approve responses so the caller can surface the diff in review UIs. */
  predicted_files_diff?: PredictedFilesDiff;
}
