# ADR 003: Runtime target

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Use Node as the V1 runtime target.

## Rationale

- aligns with pi SDK assumptions and current documentation/examples
- reduces risk in a system already heavy on session, SSE, process, file, and CLI integration
- keeps runtime novelty from competing with the core Studio product risks

## Consequences

- Bun is not part of the committed V1 runtime plan
- implementation issues should assume Node-compatible tooling and libraries
