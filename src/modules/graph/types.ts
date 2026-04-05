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
