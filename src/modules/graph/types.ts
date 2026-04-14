export type WorkItemKind = "issue" | "capability" | "phase" | "track";

/**
 * Derive the canonical work-item ID for an issue-backed item.
 * Convention: "studio-{issue_number}"
 */
export function deriveIssueWorkItemId(issueNumber: number): string {
  return `studio-${issueNumber}`;
}

/**
 * Check whether a work item's ID is aligned with its issue_number.
 * Returns null if aligned or not applicable, otherwise a diagnostic string.
 */
export function checkIdAlignment(
  id: string,
  kind: WorkItemKind,
  issueNumber: number | null | undefined,
): string | null {
  if (kind !== "issue" || issueNumber == null) return null;
  const expected = deriveIssueWorkItemId(issueNumber);
  if (id === expected) return null;
  return `ID "${id}" does not match issue_number ${issueNumber} (expected "${expected}")`;
}

export interface MisalignedWorkItem {
  id: string;
  issue_number: number;
  expected_id: string;
}
export type LegacyWorkItemState =
  | "planned"
  | "drafting"
  | "ready"
  | "in_progress"
  | "run_errored"
  | "open_pr"
  | "merged_pr"
  | "closed"
  | "deferred"
  | "done"
  | "archived"
  | "cancelled";

export type HsmPrePrLeafState = "planned" | "drafting" | "ready" | "in_progress" | "run_errored";
export type PersistedPrePrState = `pre_pr.${HsmPrePrLeafState}`;
export type PersistedDeferredState = "deferred";
export type HsmTerminalState = "open_pr" | "merged_pr" | "closed" | "done" | "archived" | "cancelled";
export type HsmLeafState = HsmPrePrLeafState | PersistedDeferredState | HsmTerminalState;
export type WorkItemState = LegacyWorkItemState | PersistedPrePrState | "run_errored" | "closed" | "archived";
export type EdgeRel = "depends_on" | "is_part_of" | "implemented_by";
export type EdgeConfidence = "certain" | "inferred" | "ambiguous";

export interface WorkItemRecord {
  id: string;
  name: string;
  kind: WorkItemKind;
  state: WorkItemState;
  repo: string | null;
  issue_number: number | null;
  issue_url: string | null;
  scope_hint: string | null;
  branch: string | null;
  archive_path: string | null;
  predicted_files: string[];
  actual_files: string[];
  meta: Record<string, unknown>;
  updated_at: string;
}

export interface EdgeRecord {
  id: number;
  from_id: string;
  rel: EdgeRel;
  to_id: string;
  confidence: EdgeConfidence;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface CreateWorkItemDto {
  id: string;
  name: string;
  kind: WorkItemKind;
  state?: WorkItemState;
  repo?: string | null;
  issue_number?: number | null;
  issue_url?: string | null;
  scope_hint?: string | null;
  branch?: string | null;
  archive_path?: string | null;
  predicted_files?: string[];
  actual_files?: string[];
  meta?: Record<string, unknown>;
}

export type UpdateWorkItemDto = Partial<Omit<CreateWorkItemDto, "id">>;

export interface CreateEdgeDto {
  from_id: string;
  rel: EdgeRel;
  to_id: string;
  confidence?: EdgeConfidence;
  meta?: Record<string, unknown>;
}

export type UpdateEdgeDto = Partial<Omit<CreateEdgeDto, "from_id" | "rel" | "to_id">>;

export interface GraphFilters {
  repo?: string;
  state?: WorkItemState;
  track?: string;
  phase?: string;
}

export interface CreateWorkItemMutation {
  mutation_id?: string;
  kind: "create_work_item";
  work_item: CreateWorkItemDto;
}

export interface UpdateWorkItemMutation {
  mutation_id?: string;
  kind: "update_work_item";
  id: string;
  patch: UpdateWorkItemDto;
}

export interface DeleteWorkItemMutation {
  mutation_id?: string;
  kind: "delete_work_item";
  id: string;
}

export interface CreateEdgeMutation {
  mutation_id?: string;
  kind: "create_edge";
  edge: CreateEdgeDto;
}

export interface UpdateEdgeMutation {
  mutation_id?: string;
  kind: "update_edge";
  id: number;
  patch: UpdateEdgeDto;
}

export interface DeleteEdgeMutation {
  mutation_id?: string;
  kind: "delete_edge";
  id: number;
}

export type GraphMutation =
  | CreateWorkItemMutation
  | UpdateWorkItemMutation
  | DeleteWorkItemMutation
  | CreateEdgeMutation
  | UpdateEdgeMutation
  | DeleteEdgeMutation;

export interface ApplyGraphMutationsDto {
  proposal_id?: string;
  based_on_graph_version?: string;
  mutations: GraphMutation[];
}

export interface GraphMutationError {
  mutation_id: string | null;
  code:
    | "missing_entity"
    | "duplicate_entity"
    | "duplicate_edge"
    | "invalid_relation"
    | "unsafe_delete"
    | "malformed_payload";
  message: string;
}

export interface GraphMutationsAppliedResult {
  status: "applied";
  proposal_id: string | null;
  applied_mutation_ids: string[];
  previous_graph_version: string;
  new_graph_version: string;
}

export interface GraphMutationsValidationFailedResult {
  status: "validation_failed";
  proposal_id: string | null;
  current_graph_version: string;
  errors: GraphMutationError[];
}

export interface GraphMutationsStaleResult {
  status: "stale";
  proposal_id: string | null;
  previous_graph_version: string;
  current_graph_version: string;
  message: string;
}

export type WorkItemHsmEvent =
  | { type: "user.start_draft" }
  | { type: "user.dispatch" }
  | { type: "user.retry" }
  | { type: "user.investigate" }
  | { type: "user.finalize" }
  | { type: "user.archive_and_finalize" }
  | { type: "user.cancel" }
  | { type: "user.defer" }
  | { type: "user.undefer" }
  | { type: "run.completed"; run_id: string; pr_exists: boolean }
  | { type: "run.error"; run_id: string; reason: string }
  | { type: "gh.pr_opened"; pull_request: Record<string, unknown> }
  | { type: "gh.pr_merged"; pull_request: Record<string, unknown> }
  | { type: "gh.issue_closed"; issue: Record<string, unknown> }
  | { type: "draft.completed" }
  | { type: "draft.failed"; reason: string };

export interface DispatchResult {
  work_item_id: string;
  prev_state: WorkItemState;
  next_state: WorkItemState;
  event: WorkItemHsmEvent;
  applied_actions: string[];
  mutation_applied: boolean;
  rejected: boolean;
  handler_data?: Record<string, unknown>;
}

/**
 * studio-196: context bag passed to each async action handler during dispatch.
 *
 * - `meta`           — mutable clone of the work item's meta; changes are
 *                      persisted in the same mutation batch as the state
 *                      transition.
 * - `handler_data`   — transient key-value bag returned in `DispatchResult`
 *                      but NOT persisted. Handlers use it to surface data
 *                      (e.g. closed-issue details) to the caller.
 * - `patch_overrides` — additional top-level work item fields (e.g.
 *                      `archive_path`) that are merged into the mutation
 *                      patch alongside the state transition.
 */
export interface HsmActionHandlerContext {
  meta: Record<string, unknown>;
  handler_data: Record<string, unknown>;
  patch_overrides: Partial<UpdateWorkItemDto>;
}

/**
 * studio-196: async side-effect handler for an HSM action.
 *
 * Registered by external modules (execution) via
 * `WorkItemHsmService.registerActionHandler()`. The handler receives the
 * work item snapshot at dispatch time and the event that triggered the
 * transition. It runs BEFORE the state write — if it throws, the
 * transition aborts and state is unchanged.
 */
export interface HsmActionHandler {
  (
    workItem: WorkItemRecord,
    event: WorkItemHsmEvent,
    context: HsmActionHandlerContext,
  ): Promise<void>;
}

export type ApplyGraphMutationsResult =
  | GraphMutationsAppliedResult
  | GraphMutationsValidationFailedResult
  | GraphMutationsStaleResult;
