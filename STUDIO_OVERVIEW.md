# Escapement Studio Overview

> AI-assisted work planning for autonomous code production.
>
> Status: design phase
> Date: 2026-04-01
> Revised: 2026-04-04

## What Studio Is

Escapement Studio is a collaborative planning environment where a human and a specialized AI agent complex co-construct the dependency graph that drives autonomous software production.

The core bet is simple:

- planning quality is the bottleneck for autonomous coding quality
- planning quality improves when structure is explicit rather than buried in prose
- the best planning artifact is a graph of dependencies, scope, ownership, and execution boundaries
- human judgment belongs at the level of decomposition and dependency design
- once the graph is good enough, it becomes executable

The graph is the point.

Not the transcript. Not the scratchpad. Not the issue body. Not a flat backlog.

Studio treats the dependency graph as the primary artifact of software planning: a living, inspectable, executable model of what work exists, what depends on what, what can run in parallel, where ownership lies, and how completed work reconciles back into the larger system.

## Core Planning Loop

1. Inspect the current graph and surrounding evidence
2. Ask the planning agent to reason about missing structure, weak boundaries, or ambiguous dependencies
3. Delegate targeted questions to code-aware specialist agents when needed
4. Stage graph mutations as explicit proposals
5. Let the human accept, reject, or revise those structural changes
6. Use the improved graph to drive safer execution and later reconciliation

## Sources of Truth

Studio is built around deliberately separated sources of truth:

- **Studio graph / SQLite manifest DB** — canonical planning structure and deterministic planning data
- **Pi session JSONL** — canonical conversation record for the rolling planning session
- **GitHub issues** — canonical execution-facing substrate for issue-backed work items
- **Git state** — canonical implementation substrate: branches, worktrees, commits, PRs
- **Planning memory** — curated durable planning context in `PLANNING_MEMORY.md`

Studio enriches and orchestrates GitHub and git rather than replacing them.

## Architecture

See `STUDIO_ARCHITECTURE.md` for the full system structure.

At a high level:

- **Browser** (Svelte) — chat surface, D3 graph panel, sidebar, mutation approval UI
- **Server** (Node, modular) — planning runtime, graph CRUD, specialist agents, GitHub/git services, execution dispatch
- **Storage** — SQLite graph DB, pi session JSONL, file-backed planning memory, async run artifacts
- **External** — GitHub issues and git as execution substrate

## Key capabilities

- rolling planning conversation with a persistent root agent
- graph-native planning UI with structured mutation proposals and approval
- specialist agents (code crawler, scope predictor, reconciliation analyst) that reduce planning uncertainty
- deterministic services for graph writes, memory, and GitHub sync
- execution orchestration driven by graph quality

## Safety principles

- graph writes, memory writes, and GitHub sync are approval-gated
- execution dispatch is previewed before launch
- sub-agents get minimal tools
- nested delegation is depth-limited
- parallel execution follows worktree safety rules

## Document Map

- `STUDIO_ARCHITECTURE.md` — detailed system structure and implementation-facing architecture
- `docs/adr/` — locked decisions
- `docs/contracts/` — implementation contracts and schemas
