export interface SendAgentMessageDto {
  message: string;
}

export interface SendAgentMessageResult {
  accepted: true;
  queued: boolean;
  session_id: string;
  session_file?: string;
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
