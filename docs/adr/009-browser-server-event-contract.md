# ADR 009: Browser/server event contract

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Browser consumes SSE from the server. The canonical event vocabulary uses pi SDK-native event names wrapped in a thin Studio envelope.

Canonical event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

Studio may add a minimal set of extension events, including:

- `mutation_proposal`
- `subagent_status`
- `graph_commit_result`

V1 reconnect is best-effort rather than full durable replay.

## Rationale

- preserves fidelity with the server-side pi session stream
- avoids inventing a redundant parallel event taxonomy
- gives the browser enough structure for rendering and recovery

## Consequences

- the SSE layer should keep SDK-native names visible
- browser recovery should combine SSE resubscription with current-state snapshot fetches
