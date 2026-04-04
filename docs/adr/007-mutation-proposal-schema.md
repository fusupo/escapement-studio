# ADR 007: Mutation proposal schema

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

The planning agent emits structured batched mutation envelopes. Each proposed change has a stable mutation ID. V1 mutation types are:

- `create_work_item`
- `update_work_item`
- `create_edge`
- `delete_edge`
- `delete_work_item`

Each mutation includes explicit typed payload, human-readable rationale, and optional validation/grouping metadata. The browser approves selected mutation IDs, not freeform text.

## Rationale

- supports inspectable UI rendering
- makes approval deterministic
- creates a clean interface between agent output and graph writes

## Consequences

- proposal rendering should be based on stable IDs and typed payloads
- graph commit requests should submit approved mutation IDs plus graph version context
- delete operations should remain more constrained than create/update operations in V1
