# Planning Memory

## Product Principles
- Escapement Studio treats the dependency graph as the primary planning artifact.
- Chat is where ideas emerge; the graph is where planning becomes operational.

## Architecture Decisions
- Use Node for the V1 runtime.
- Use Svelte for the V1 frontend.
- Use a Studio-owned adapter around `@mariozechner/pi-web-ui`.
- Use pi session JSONL as the canonical conversation store.
- Serialize graph context as triples.
- Use a hybrid execution backend with Studio-owned orchestration over pi SDK primitives.

## Planning Conventions
- Keep planning docs and issues lean and demoable.
- Prefer explicit, approval-gated structural updates over append-only planning sprawl.
- GitHub issues are the execution-facing substrate; the Studio graph is canonical for planning structure.

## Active Open Questions
- None yet.

## Reconciliation Learnings
- None yet.
