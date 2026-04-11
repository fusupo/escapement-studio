import type { WorkItemState } from "./types.js";

/**
 * Allowlist of human-reviewer-triggered work item state transitions.
 *
 * This list covers transitions that are initiated by a human via the
 * transition endpoint (`POST /api/work-items/:id/transition`). It does
 * NOT cover execution-service-triggered transitions that happen as a
 * side effect of launch, run completion, or PR sync — those are wired
 * in ExecutionService directly.
 *
 * See `docs/adr/014-plans-runs-state-model.md` for the canonical
 * transition table and actor assignments.
 */
export const VALID_HUMAN_TRANSITIONS: Record<WorkItemState, WorkItemState[]> = {
  planned: ["drafting", "deferred", "cancelled"],
  drafting: ["ready", "deferred", "cancelled"],
  ready: ["drafting", "deferred", "cancelled"],
  in_progress: ["ready", "drafting", "deferred", "cancelled"],
  run_errored: [],
  open_pr: ["deferred", "cancelled"],
  merged_pr: [],
  closed: [],
  deferred: ["planned"],
  done: [],
  archived: [],
  cancelled: [],
};

/**
 * Return true if a human reviewer is allowed to transition a work item
 * from `from` to `to`.
 */
export function isValidHumanTransition(from: WorkItemState, to: WorkItemState): boolean {
  return VALID_HUMAN_TRANSITIONS[from]?.includes(to) ?? false;
}
