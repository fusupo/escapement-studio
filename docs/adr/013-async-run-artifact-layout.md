# ADR 013: Async run artifact layout

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Long-running planning, sub-agent, execution, and reconciliation operations produce run-scoped artifacts under a configurable context/artifact root.

V1 standard files per run:

- `metadata.json`
- `status.json`
- `events.jsonl`
- `summary.md` where practical
- optional `outputs/`

Artifacts are operational records distinct from the browser SSE stream.

## Rationale

- creates predictable observability for async work
- supports debugging, review, and post-run inspection
- borrows proven patterns without overcomplicating storage

## Consequences

- each run needs a stable run ID and run type
- `status.json` is a mutable snapshot while `events.jsonl` is append-only
- artifact storage should live outside normal committed source files or in an ignored directory
