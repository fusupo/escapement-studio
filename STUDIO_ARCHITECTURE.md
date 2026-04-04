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
