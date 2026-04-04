# Event stream contract

## Purpose

Define the browser/server SSE contract for planning session activity.

## Transport

- server streams events over SSE
- SSE `event:` field should match the logical event type
- event JSON includes a thin Studio envelope

Example SSE frame:

```text
id: evt_000123
event: message_update
data: {"event_id":"evt_000123","stream_id":"planning-root","timestamp":"2026-04-04T19:10:00Z","event_type":"message_update","session_id":"planning-root","turn_id":"turn_184","payload":{"message_id":"msg_991","delta":"hello"}}
```

## Envelope

```json
{
  "event_id": "evt_000123",
  "stream_id": "planning-root",
  "timestamp": "2026-04-04T19:10:00Z",
  "event_type": "message_update",
  "session_id": "planning-root",
  "turn_id": "turn_184",
  "payload": {}
}
```

## Canonical event types

### pi SDK-native

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`

### Studio extension events

- `mutation_proposal`
- `subagent_status`
- `graph_commit_result`

## V1 reconnect policy

- best-effort reconnect, not full durable replay
- browser may use `Last-Event-ID` if supported
- browser should recover by refetching current state/session snapshot as needed

## Notes

- preserve SDK-native event names rather than inventing a parallel vocabulary
- tool and message lifecycle distinctions must remain visible to the browser
