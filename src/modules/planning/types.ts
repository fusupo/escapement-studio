import type { AgentSession } from "@mariozechner/pi-coding-agent";

export type PlanningContextGraphMode = "default" | "focused" | "full";

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

export interface PlanningSessionSnapshot {
  session_id: string;
  session_file?: string;
  is_streaming: boolean;
  messages: PlanningSessionTranscriptEntry[];
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
