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

/**
 * ADR 014 step 8 follow-up (#167) — JSON envelope returned by the
 * `PlanDrafterService` after running the setup-work skill against a work item.
 *
 * The drafter is told to return exactly this shape so the caller can inject
 * each field into the canonical scratchpad sections without parsing markdown.
 */
export interface PlanDraftEnvelope {
  /** One-paragraph statement of what the plan proposes. */
  summary: string;
  /** Acceptance criteria, parsed from the issue body or distilled by the drafter. */
  acceptance_criteria: string[];
  /** Atomic, dependency-ordered implementation tasks. */
  implementation_tasks: PlanDraftTask[];
  /** Refined predicted files — replaces the work item's `predicted_files` on success. */
  affected_files: string[];
  /** Open questions the drafter could not resolve. Surfaced for the reviewer. */
  questions: string[];
  /** Assumptions the drafter had to make in absence of clarification. */
  assumptions: string[];
  /** Blocking dependencies on other issues. */
  blockers: string[];
  /** Free-form architecture / approach / challenges notes. */
  technical_notes: PlanDraftTechnicalNotes;
}

export interface PlanDraftTask {
  description: string;
  files: string[];
  rationale: string;
  testing: string;
}

export interface PlanDraftTechnicalNotes {
  architecture: string;
  approach: string;
  challenges: string;
}
