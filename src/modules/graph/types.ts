export type WorkItemKind = "issue" | "capability" | "phase" | "track";
export type WorkItemState = "planned" | "in_progress" | "done" | "deferred" | "cancelled";
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

export type ApplyGraphMutationsResult =
  | GraphMutationsAppliedResult
  | GraphMutationsValidationFailedResult
  | GraphMutationsStaleResult;
