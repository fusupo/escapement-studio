# Escapement Studio Architecture

## Runtime and frontend

- **Runtime:** Node for V1
- **Frontend:** Svelte
- **Chat UI strategy:** Studio-owned adapter around `@mariozechner/pi-web-ui`
- **Graph rendering:** D3
- **Server-browser transport:** REST + SSE
- **Database:** SQLite

## Browser architecture

```text
Svelte app
├── Chat panel host
│   └── Studio adapter around pi-web-ui
├── D3 graph panel
├── Sidebar
├── Toolbar / filters
└── data layer
    ├── REST client
    └── SSE event client
```

Responsibilities:

- render the rolling planning conversation
- render the dependency graph and local edits
- render mutation proposals, approvals, and revise flows
- render sub-agent status and graph commit results
- keep graph state, chat state, and approval state in one workspace

## Server architecture

```text
GraphModule
├── SQLiteService
├── WorkItemsService
├── EdgesService
├── GraphWriterService
└── GraphController

PlanningModule
├── PlanningService
├── PlanningController
├── ContextService
├── ConversationService
└── MemoryService

AgentModule
└── SubAgentService

GitHubModule
└── GitHubService

GitModule
└── GitService

ExecuteModule
└── DispatchService
```

## Root planning session model

See ADR 004 for the session/history decision.

- root planner runs server-side via pi SDK
- one persistent root planning session as the default rolling conversation
- session boundaries are a system concern, not a primary V1 UX concept

## Graph model

Studio uses the existing manifest-style graph of work items and edges.

Work item kinds include:

- issue
- capability
- phase
- track

Edge kinds include:

- depends_on
- is_part_of
- implemented_by

The graph is canonical for planning structure, decomposition, dependencies, and execution boundaries.

## Graph context serialization

The root planner sees graph state as triples.

Default per-turn slice:

- frontier items
- blocked items
- immediate dependencies
- relevant local hierarchy

Additional modes:

- **focused** — repo/track-specific slice
- **full** — whole graph for explicit structural analysis

## Planning workflow

See `STUDIO_OVERVIEW.md` for the core planning loop.

The architecture supports this through:
- graph context serialization (triples) fed to the root planner each turn
- structured mutation proposals emitted by the planner
- browser rendering of proposals as selectable staged changes
- atomic server-side apply of approved mutations

## Execution run disposition

ADR 014 step 7 defines two terminal flows for a `merged_pr` work item:
Close (non-archival) and Archive-and-close. Both live on `ExecutionService`
and share the same source-state and active-run guards.

The Close flow (`POST /api/execution/close-merged`, studio-87) is backend‑
owned and atomically performs:

1. `assertWorkItemInMergedPr` — guard the source state. An already‑`done`
   work item short‑circuits the guards so retries after a partial failure
   still run the finalizer.
2. `assertNoActiveRunForWorkItem` — refuse while a run is live.
3. `GitHubService.closeIssue` — skipped when the work item is not issue‑
   backed. `gh issue close` is idempotent so retries are safe.
4. `WorkItemsService.update({ state: 'done' })` — skipped on the already‑
   done retry path.
5. `removeRunsForWorkItem` finalizer — splices matching runs out of
   `recentRuns`, stamps `disposed_at` on each `runs/<id>/status.json`, and
   emits `execution_result` events.

The `disposed_at` marker is how closed runs stay out of the recent‑runs
list across a server restart without deleting the artifact dir: a run
with a non‑null `disposed_at` is filtered by `loadRunRecordsFromDisk`
(and therefore by both `hydrateRecentRunsFromDisk` and the reconciler)
unless a caller explicitly passes `includeDisposed: true`. The artifacts
are preserved on disk so issue #89 (archived execution run history) can
surface them later.

The response envelope (`CloseMergedPullRequestResult`) bundles the
updated work item, the closed GitHub issue summary, the ids of removed
runs, and a post‑close `dispatch_preview` so the UI can reflect the
combined outcome in a single round trip — mirroring the shape returned
by `syncMergedPullRequest`.

## Contracts

Detailed specs for the interfaces between these components live in `docs/contracts/`:

- `mutation-proposals.md` — proposal envelope, mutation types, approval request shape
- `graph-commit-semantics.md` — validation, atomic apply, stale detection, result shapes
- `event-stream.md` — SSE envelope, SDK-native + Studio extension event types, reconnect
- `planning-memory.md` — what belongs in memory, write/read policy
- `subagent-responses.md` — shared response envelope, finding shapes, specialist types
- `github-sync.md` — sync scope, managed block format, safety rules
- `run-artifacts.md` — per-run artifact layout, required files, run types

## Implementation

See `IMPLEMENTATION_PLAN.md` for delivery waves and issue breakdown.
