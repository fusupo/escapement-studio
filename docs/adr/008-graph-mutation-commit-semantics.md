# ADR 008: Graph mutation commit semantics

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Approved mutation subsets are committed atomically in a deterministic server-side apply path.

Rules for V1:

- user may approve any subset of proposal mutations
- selected subset is committed atomically in one transaction
- full batch validation occurs before any write
- no partial success
- server applies mutations in normalized order
- stale proposals are rejected based on graph version
- retries should be idempotent where practical
- `delete_work_item` is restricted to safe cases

## Rationale

- optimizes for trust and recoverability
- prevents malformed half-applied graph state
- keeps UI behavior simple to explain

## Consequences

- server must own validation and ordering independent of agent output ordering
- graph versioning is required for stale detection
- apply responses must surface success, validation failure, and stale outcomes explicitly
