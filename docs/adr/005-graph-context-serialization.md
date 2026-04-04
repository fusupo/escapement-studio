# ADR 005: Graph context serialization

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Serialize graph state for the root planner as triples.

Default per-turn graph context includes:

- frontier items
- blocked items
- immediate dependencies
- relevant local hierarchy

Additional modes:

- focused slice by repo or track
- full graph only for explicit structural analysis

## Rationale

- keeps context compact and reasoning-friendly
- emphasizes the graph slice most relevant to current planning decisions
- retains a path for deeper structural inspection when needed

## Consequences

- graph query/context services should support default, focused, and full modes explicitly
- prompt construction should not include the full graph by default
