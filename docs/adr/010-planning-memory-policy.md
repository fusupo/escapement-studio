# ADR 010: Planning memory policy

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Use `PLANNING_MEMORY.md` as file-backed durable planning memory.

Planning memory stores curated durable planning context rather than transcript residue. Writes are approval-gated and should prefer targeted updates/replacements over append-only growth.

Good memory content includes:

- architecture decisions
- durable planning principles
- stable conventions
- important deferred questions
- reconciliation learnings

## Rationale

- preserves a compact and useful long-term planning memory
- separates durable context from session history
- keeps memory understandable to humans and agents

## Consequences

- memory tooling should support targeted edits rather than indiscriminate appends
- memory should remain small enough to read directly in planner context
