# ADR 006: Execution orchestration backend

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Use a hybrid execution backend.

Studio owns planning and runtime architecture. Execution may use raw pi SDK sessions where appropriate while borrowing or composing with pi-subagents-style patterns for parallel fan-out, worktree safety, async artifacts, and status tracking.

## Rationale

- preserves Studio as the primary planning/runtime environment
- reuses proven orchestration patterns without making pi-subagents the architectural center
- fits the graph-driven execution model

## Consequences

- execution work should distinguish Studio-owned orchestration from borrowed pattern/mechanism reuse
- dispatch previews, worktree safety, and async artifact conventions should intentionally resemble proven subagent workflows
