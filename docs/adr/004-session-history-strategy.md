# ADR 004: Session and history strategy

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Use pi session JSONL as the canonical conversation store.

Studio presents a rolling planning conversation by keeping one persistent root planning session. SQLite conversation projections are optional and secondary, not required for V1.

## Rationale

- preserves fidelity with the pi SDK session model
- supports the desired rolling-chat UX without inventing a competing persistence system
- avoids dual sources of truth for conversation history

## Consequences

- session boundaries are primarily a system concern, not a primary V1 UX concept
- browser history/search/indexing may later add SQLite projections if needed, but they remain derived views
