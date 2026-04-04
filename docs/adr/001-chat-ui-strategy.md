# ADR 001: Chat UI strategy

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Use `@mariozechner/pi-web-ui` as the initial chat UI foundation behind a Studio-owned adapter boundary.

The server-hosted pi SDK session remains the source of truth. Studio-specific rendering and control flow stay Studio-owned. A custom chat surface remains an explicit fallback if integration becomes too awkward.

## Rationale

- biases toward reuse for chat rendering and streaming basics
- preserves the server-hosted planning session architecture
- avoids overcommitting to undocumented remote-session assumptions
- keeps mutation-centric UX under Studio control

## Consequences

- an early spike should validate SSE ingestion, SDK-native event rendering, custom mutation cards, and reconnect behavior
- the adapter boundary must remain clean so a later custom chat surface can replace pi-web-ui if needed
