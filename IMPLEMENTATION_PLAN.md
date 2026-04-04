# Escapement Studio Implementation Plan

## Delivery waves

Each issue should represent a demoable deliverable, not a single function or endpoint.

### Wave 1: Graph-backed shell
Get a working server and graph workspace in the browser.

1. **Server scaffold + graph API**
   - modular server skeleton, config, SQLite service
   - import manifest core from `escapement-pi/src/core`
   - work items + edges CRUD endpoints
   - graph/frontier/plan query endpoints
   - graph filtering by repo/state/track/phase

2. **Graph frontend**
   - Vite + Svelte scaffold
   - D3 graph rendering from graph API
   - node detail sidebar with edit/create
   - edge create/delete interactions
   - filters toolbar

3. **Graph writer + versioning**
   - deterministic graph writer service
   - transaction safety, validation
   - graph version tracking for stale detection

### Wave 2: Planning runtime
Connect the graph workspace to a persistent planning agent.

4. **Root planning session**
   - `PlanningService` around pi SDK session
   - agent message endpoint
   - SSE stream endpoint
   - session persistence wiring

5. **Context assembly + triples**
   - `ContextService`: vision docs, memory, graph triples, conversation window
   - triples serialization with default/focused/full modes

6. **Browser chat integration**
   - Studio adapter boundary for `pi-web-ui`
   - browser chat transport over REST + SSE
   - validate remote session rendering assumptions

### Wave 3: Core differentiator
Mutation approval workflow and planning memory — the things that make Studio Studio.

7. **Mutation proposal + approval flow**
   - `graph_query`, `propose_mutations`, `graph_mutate` tools
   - mutation proposal rendering in browser
   - approve/reject/revise actions
   - atomic graph commit endpoint with stale/conflict handling

8. **Planning memory**
   - initial `PLANNING_MEMORY.md` template
   - memory read/write services + tools
   - approval-gated write flow with targeted edits
   - memory change rendering in UI

### Wave 4: Specialists + GitHub
Reduce planning uncertainty and connect to the execution substrate.

9. **Sub-agent framework + specialists**
   - `SubAgentService` for ephemeral sessions
   - `delegate_subagent` tool on root agent
   - code crawler and scope predictor specialists
   - sub-agent activity/result rendering in browser
   - run artifact persistence for specialist runs

10. **GitHub integration**
    - GitHub service via `gh` CLI
    - read endpoint/tooling for issue details
    - approval-gated sync with managed issue body block
    - issue details/links in sidebar

### Wave 5: Execution + reconciliation
Close the loop from plan to action to learning.

11. **Execution dispatch**
    - dispatch plan endpoint/service
    - dispatch preview UI
    - worktree/branch safety checks
    - execution launch orchestration
    - status streaming + run artifact persistence

12. **Reconciliation**
    - reconciliation analyst specialist
    - predicted vs actual file comparison
    - drift/overlap reporting in UI
    - reconciliation learnings fed back to memory

---

## Dependencies

- wave 2 requires wave 1
- wave 3 requires waves 1 + 2
- wave 4 requires wave 2 (sub-agents need planning runtime; GitHub needs graph data)
- wave 5 requires waves 1–4

Within each wave, issues can often be worked in parallel.

---

## Out of scope for V1

- Bun runtime
- persistent specialist pools
- automatic issue closure
- full durable event replay
- rich multi-project coordination
- ghost rendering beyond basic staged preview

---

## Done definitions

**Planning-ready:** can load/edit graph, host a persistent planner, stream activity to browser, render and approve mutation proposals, maintain planning memory, delegate to at least one specialist, sync issue-backed items to GitHub.

**Execution-ready:** can additionally generate dispatch plans, preview execution, launch worktree-isolated runs, stream status, persist artifacts, reconcile plan vs actual.
