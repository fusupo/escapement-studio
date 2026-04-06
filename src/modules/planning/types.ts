import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ApplyGraphMutationsResult, EdgeRel, WorkItemKind, WorkItemState } from "../graph/types.js";

export type PlanningContextGraphMode = "default" | "focused" | "full";
export type PlanningMutationType = "create_work_item" | "update_work_item" | "create_edge" | "delete_edge" | "delete_work_item";
export type PlanningMemoryEditKind = "replace_text" | "insert_after_heading" | "delete_text";

export interface SendAgentMessageDto {
  message: string;
  context?: {
    graph_mode?: PlanningContextGraphMode;
    repo?: string;
    track?: string;
  };
}

export interface SendAgentMessageResult {
  accepted: true;
  queued: boolean;
  session_id: string;
  session_file?: string;
}

export interface PlanningSessionTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  tool_name?: string;
  is_error?: boolean;
}

export interface PlanningMutationProposalSource {
  agent: string;
  turn_id?: string | null;
  session_id: string;
}

export interface PlanningMutationProposalContext {
  scope?: string;
  mode?: PlanningContextGraphMode;
  based_on_graph_version?: string;
}

export interface PlanningMutationProposalMutation {
  id: string;
  type: PlanningMutationType;
  entity_id?: string;
  payload?: Record<string, unknown>;
  rationale: string;
  validation?: Record<string, unknown>;
  group_id?: string;
  depends_on_mutation_ids?: string[];
}

export interface PlanningMutationProposal {
  proposal_id: string;
  created_at: string;
  source: PlanningMutationProposalSource;
  context?: PlanningMutationProposalContext;
  summary: string;
  mutations: PlanningMutationProposalMutation[];
}

export interface ApproveMutationProposalDto {
  proposal_id: string;
  approved_mutation_ids: string[];
}

export interface PlanningGraphCommitResult {
  proposal_id: string;
  approved_mutation_ids: string[];
  result: ApplyGraphMutationsResult;
  active_proposal: PlanningMutationProposal | null;
}

export interface PlanningMemoryDocument {
  path: string;
  content: string;
  content_hash: string;
}

export interface PlanningMemoryEdit {
  id: string;
  kind: PlanningMemoryEditKind;
  summary: string;
  rationale: string;
  old_text?: string;
  new_text?: string;
  target_heading?: string;
}

export interface PlanningMemoryChange {
  change_id: string;
  created_at: string;
  source: PlanningMutationProposalSource;
  summary: string;
  based_on_content_hash: string;
  edits: PlanningMemoryEdit[];
}

export interface ApprovePlanningMemoryChangeDto {
  change_id: string;
  approved_edit_ids: string[];
}

export interface PlanningMemoryApplySuccess {
  status: "applied";
  applied_edit_ids: string[];
  previous_content_hash: string;
  new_content_hash: string;
}

export interface PlanningMemoryApplyValidationFailure {
  status: "validation_failed";
  errors: Array<{ edit_id: string; message: string }>;
}

export interface PlanningMemoryApplyStale {
  status: "stale";
  previous_content_hash: string;
  current_content_hash: string;
  message: string;
}

export type PlanningMemoryApplyResult =
  | PlanningMemoryApplySuccess
  | PlanningMemoryApplyValidationFailure
  | PlanningMemoryApplyStale;

export interface PlanningMemoryWriteResult {
  change_id: string;
  approved_edit_ids: string[];
  result: PlanningMemoryApplyResult;
  active_memory_change: PlanningMemoryChange | null;
  memory: PlanningMemoryDocument;
}

export interface PlanningSessionSnapshot {
  session_id: string;
  session_file?: string;
  is_streaming: boolean;
  messages: PlanningSessionTranscriptEntry[];
  active_proposal: PlanningMutationProposal | null;
  last_commit_result: PlanningGraphCommitResult | null;
  active_memory_change: PlanningMemoryChange | null;
  last_memory_write_result: PlanningMemoryWriteResult | null;
  memory: PlanningMemoryDocument;
}

export interface StudioSseEnvelope {
  event_id: string;
  stream_id: string;
  timestamp: string;
  event_type: string;
  session_id: string;
  turn_id: string | null;
  payload: unknown;
}

export interface AssemblePlanningContextInput {
  graph_mode?: PlanningContextGraphMode;
  repo?: string;
  track?: string;
  session?: AgentSession;
}

export interface PlanningContextDocument {
  kind: "studio_overview" | "studio_architecture" | "planning_memory";
  label: string;
  path: string;
  content: string;
}

export interface PlanningContextTriple {
  subject: string;
  predicate: string;
  object: string;
}

export interface PlanningContextGraph {
  mode: PlanningContextGraphMode;
  filters: {
    repo?: string;
    track?: string;
  };
  item_count: number;
  edge_count: number;
  triple_count: number;
  triples: PlanningContextTriple[];
}

export interface PlanningContextMessage {
  role: string;
  content: string;
  timestamp: string;
}

export interface PlanningContext {
  generated_at: string;
  documents: PlanningContextDocument[];
  graph: PlanningContextGraph;
  conversation_window: PlanningContextMessage[];
}

export interface ProposeMutationsToolInput {
  proposal_id?: string;
  created_at?: string;
  source?: Partial<PlanningMutationProposalSource>;
  context?: PlanningMutationProposalContext;
  summary: string;
  mutations: Array<{
    id?: string;
    type: PlanningMutationType;
    entity_id?: string;
    payload?: Record<string, unknown>;
    rationale: string;
    validation?: Record<string, unknown>;
    group_id?: string;
    depends_on_mutation_ids?: string[];
  }>;
}

export interface ProposeMemoryWriteToolInput {
  change_id?: string;
  created_at?: string;
  source?: Partial<PlanningMutationProposalSource>;
  summary: string;
  edits: Array<{
    id?: string;
    kind: PlanningMemoryEditKind;
    summary: string;
    rationale: string;
    old_text?: string;
    new_text?: string;
    target_heading?: string;
  }>;
}

export interface GraphQueryToolInput {
  query: "graph" | "frontier" | "plan";
  repo?: string;
  state?: WorkItemState;
  track?: string;
  phase?: string;
}

export interface CreateWorkItemPayload {
  id?: string;
  name?: string;
  kind?: WorkItemKind;
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

export interface UpdateWorkItemPayload extends Omit<CreateWorkItemPayload, "id"> {}

export interface CreateEdgePayload {
  from_id?: string;
  rel?: EdgeRel;
  to_id?: string;
  confidence?: "certain" | "inferred" | "ambiguous";
  meta?: Record<string, unknown>;
}
