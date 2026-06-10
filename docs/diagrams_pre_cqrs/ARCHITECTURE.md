# Escapement Studio — Architecture Guide

This is a narrative walk-through of how the codebase fits together. It
references the PlantUML diagrams under `components/` and `sequences/` so you
can jump to the picture that matches the text.

> Grounding: everything here is derived from the code as of this write-up.
> File paths are hyperlinks into the source tree so nothing drifts silently.

---

## 1. The product in one paragraph

Escapement Studio is a planning and execution workspace for autonomous code
production. A human and a persistent planning agent co-construct a graph of
work items and dependencies; Studio enforces structural changes through
**approval-gated mutations**; once a work item is `ready`, Studio can
launch an isolated execution run inside a dedicated git worktree, drive it
through phase-based agent turns, and then reconcile the result back into
graph state through a state machine. The graph is the canonical planning
artifact — GitHub issues, runs, and worktrees are all orchestrated around
it.

See **`components/01-system-overview.puml`** for the ten-thousand-foot view.

---

## 2. Runtime topology

Two processes:

1. **Server** — NestJS app booted from
   [`src/main.ts`](../../src/main.ts). Everything Studio-side lives here:
   HTTP controllers, SSE streams, SQLite graph store, Pi-coding-agent
   sessions, execution orchestration, GitHub/git integration, scheduled
   cache sweeps. Default port 3000 (overridable via `.env`).
2. **Browser** — Svelte frontend in [`web/`](../../web/) served by Vite.
   Speaks REST + SSE to the server via [`web/src/lib/api.js`](../../web/src/lib/api.js)
   and [`web/src/lib/planner-chat.js`](../../web/src/lib/planner-chat.js).

External collaborators:

- **GitHub** — reached through the `gh` CLI wrapper in
  [`src/modules/github/github.service.ts`](../../src/modules/github/github.service.ts).
- **git** — local worktrees under `<artifact-root>/worktrees/<branch>/`
  managed via `git worktree add/remove` and scoped `git` invocations in
  [`src/modules/execution/execution.service.ts`](../../src/modules/execution/execution.service.ts).
- **Pi coding agent** — `@mariozechner/pi-coding-agent` sessions host
  both the root planner conversation and the ephemeral specialist /
  execution / drafter sessions.

Storage (see **`components/05-filesystem-layout.puml`**):

- **Graph manifest** — SQLite database at `${MANIFEST_PATH}/manifest.db`
  (default `.manifest/`). Tables: `work_items`, `edges`, `studio_metadata`.
- **Planning session** — JSONL under `${PLANNING_SESSION_DIR}/` so the root
  planner conversation is durable across restarts.
- **Context root** — `${ARTIFACT_ROOT}` (default
  `/home/marc/escapement-studio-ctx/`) holding `plans/<slug>/`,
  `runs/<run_id>/`, `worktrees/<branch>/`, and `archives/<slug>/`. Slugs
  are derived by
  [`workItemSlug`](../../src/lib/context-layout.ts) (e.g. `studio-1234 →
  studio_1234`).
- **Planning memory** — curated markdown at
  [`PLANNING_MEMORY.md`](../../PLANNING_MEMORY.md).

---

## 3. Backend module wiring

NestJS organizes the server into nine feature modules, imported from
[`src/app.module.ts`](../../src/app.module.ts). See
**`components/02-backend-modules.puml`** for the full dependency graph,
including the `forwardRef` circularities.

| Module | Purpose | Key files |
|---|---|---|
| `GraphModule` | SQLite manifest + atomic writer + HSM | `src/modules/graph/**` |
| `ExecutionModule` | Dispatch, worktrees, run artifacts, reconcile, GH cache | `src/modules/execution/**` |
| `PlanningModule` | Root planner session, context assembly, planner tools | `src/modules/planning/**` |
| `PlansModule` | Plan prepare/approve/reopen + auto-drafter | `src/modules/plans/**` |
| `GitHubModule` | `gh` CLI wrapper + issue templates + managed block sync | `src/modules/github/**` |
| `ReconciliationModule` | Predicted vs actual file drift reports | `src/modules/reconciliation/**` |
| `SettingsModule` | Persisted app settings + pi model registry | `src/modules/settings/**` |
| `HealthModule` | Liveness probe | `src/modules/health/**` |
| (`GitModule`) | `GitService` repo discovery helper — **defined but not imported by AppModule** | `src/modules/git/git.service.ts` |

The circular-dependency pairs that matter:

- `GraphModule ↔ ExecutionModule` — execution needs to read the graph and
  dispatch HSM events; the graph module's `WorkItemsController` delegates
  cancel/delete to `ExecutionService.cancelWorkItem` and also the
  `user.start_draft` routing depends on `PlansService` and
  `ExecutionService`.
- `GraphModule ↔ PlansModule` — plans need to read/mutate work items and
  dispatch HSM events, and the HSM chart triggers plan drafting.
- `GraphModule ↔ GitHubModule` — the graph module uses
  `GitHubService.closeIssue` from inside HSM action handlers registered by
  `ExecutionService`.

All of these are resolved with `forwardRef(() => OtherModule)` at the
`@Module({ imports })` level and `@Inject(forwardRef(() => OtherService))`
at the constructor.

---

## 4. Key services and their collaborations

See **`components/03-backend-services.puml`** for the service-level class
diagram.

### Graph
- [`SQLiteService`](../../src/modules/graph/sqlite.service.ts) — opens the
  shared `better-sqlite3` handle, owns the `work_items` CHECK-constraint
  migration for ADR 014 + 015 states, and maintains `studio_metadata.graph_version`.
- [`WorkItemsService`](../../src/modules/graph/work-items.service.ts) and
  [`EdgesService`](../../src/modules/graph/edges.service.ts) — CRUD facades
  that funnel every write through `GraphWriterService`.
- [`GraphWriterService`](../../src/modules/graph/graph-writer.service.ts) —
  the one and only atomic mutation path. Validates the full batch before
  writing anything, normalizes mutation order, honors
  `based_on_graph_version` for stale detection, and bumps the graph version
  on success.
- [`GraphService`](../../src/modules/graph/graph.service.ts) — read-only
  queries: filtered graph slices, frontier, Studio-local dispatch plan
  (re-implements upstream `queryFrontier` to widen state to
  `planned | ready | pre_pr.planned | pre_pr.ready`).
- [`GraphEventsService`](../../src/modules/graph/graph-events.service.ts) —
  SSE subject that emits `work_item_state_changed` envelopes on HSM writes.
- [`WorkItemHsmService`](../../src/modules/graph/work-item-hsm.service.ts)
  — the canonical state machine. Parses
  [`work-item.scxml`](../../src/modules/graph/work-item.scxml) on module
  init via `@scion-scxml/core`, normalizes `pre_pr.*` leaf states, runs
  registered async action handlers, then applies the single
  `update_work_item` mutation through `GraphWriterService`. Emits a
  `work_item_state_changed` event after each successful transition.
- [`HsmActionHandlers`](../../src/modules/graph/hsm-action-handlers.ts) and
  [`HsmGuardHandlers`](../../src/modules/graph/hsm-guard-handlers.ts) —
  injectable implementations of named SCXML actions (`createRunRecord`,
  `closeGhIssue`, `runArchiver`, `kickOffPlanDrafter`) and guards
  (`prExistsForBranch`). Note: in the current code the live action handlers
  for `closeGhIssue` and `runArchiver` are registered _inline_ by
  `ExecutionService.onModuleInit` rather than by this class; treat
  `HsmActionHandlers` as the shared vocabulary tests exercise directly.

### Execution
- [`ExecutionService`](../../src/modules/execution/execution.service.ts) —
  the big service. Owns the `recentRuns` in-memory buffer (cap 16), drives
  every phase of an execution run, manages worktrees, writes
  `runs/<id>/status.json` + `events.jsonl`, and implements the merged-PR
  disposition flows (`closeMergedPullRequest`,
  `archiveAndCloseMergedPullRequest`, `cancelWorkItem`). Registers its
  SCXML action handlers on module init.
- [`GitHubBatchCache`](../../src/modules/execution/github-batch-cache.service.ts)
  — a 60-second TTL cache of `gh pr list` / `gh issue list` results per
  repo, with in-flight deduplication and write-through updates.
- [`GitHubCacheScheduler`](../../src/modules/execution/github-cache-scheduler.service.ts)
  — `@Cron(EVERY_MINUTE)` sweeps that invalidate the cache, refetch, then
  dispatch `gh.pr_opened` / `gh.pr_merged` / `gh.issue_closed` events for
  any work item whose local state is behind GitHub. Also exposed on-demand
  via `POST /api/github-cache/refresh`.
- [`WorkItemReconcilerService`](../../src/modules/execution/work-item-reconciler.service.ts)
  — derives a "next action" view per work item (row-order decision table),
  detects orphaned runs on startup, and runs an initial reconcile pass.
  Surfaced at `GET /api/work-items/reconciled`.
- [`run-disk-store.ts`](../../src/modules/execution/run-disk-store.ts) and
  [`run-archiver.ts`](../../src/modules/execution/run-archiver.ts) — pure
  filesystem helpers used by `ExecutionService` for rehydration, orphan
  rewrite, and archive bundles.

### Plans
- [`PlansService`](../../src/modules/plans/plans.service.ts) — ADR 014
  plan lifecycle (`prepare → drafting → ready → drafting` via reopen).
  Runs the auto-drafter on every `prepare`, injects the envelope into the
  canonical scratchpad template, and refines `predicted_files` from the
  envelope.
- [`PlanDrafterService`](../../src/modules/plans/plan-drafter.service.ts)
  — wraps `createAgentSession` with read-only tools (`Read`, `Grep`,
  `Bash`) scoped to `process.cwd()`, embeds the bundled
  `escapement/skills/setup-work/SKILL.md` into the prompt, and parses the
  final assistant message as a `PlanDraftEnvelope`. Retries once on a
  specific empty-response failure mode.

### Planning (root planner)
- [`PlanningService`](../../src/modules/planning/planning.service.ts) —
  hosts the persistent root planning session via
  `@mariozechner/pi-coding-agent`, registers Studio-specific custom tools
  (`graph_query`, `propose_mutations`, `graph_mutate`, `memory_read`,
  `memory_write`, `delegate_subagent`, `github_read`,
  `github_create_issue`, `github_sync`, `reconciliation_query`), fans
  events out over SSE, and stages approval-gated proposals (graph
  mutations, memory changes, GitHub syncs).
- [`ContextService`](../../src/modules/planning/context.service.ts) —
  assembles the per-turn context payload: truncated `STUDIO_OVERVIEW.md`
  + `STUDIO_ARCHITECTURE.md`, `PLANNING_MEMORY.md`, optional issue
  templates, graph triples for the selected slice (default / focused /
  full), and an 8-message conversation window.
- [`MemoryService`](../../src/modules/planning/memory.service.ts) —
  reads/writes `PLANNING_MEMORY.md` with per-edit validation
  (`replace_text`, `delete_text`, `insert_after_heading`) and SHA-1
  content-hash based optimistic concurrency.
- [`SubAgentService`](../../src/modules/planning/sub-agent.service.ts) —
  spawns ephemeral pi sessions for `code-crawler` / `scope-predictor` /
  `reconciliation-analyst`, writes per-run artifacts under
  `runs/sub_<ts>/`, parses structured JSON envelopes.

### GitHub
- [`GitHubService`](../../src/modules/github/github.service.ts) — the
  only place in the codebase that shells out to `gh`. Handles issue
  read/create/close/delete, PR read/list/find-by-branch, and the managed
  `studio-sync:start/end` issue body block flow. Registers a "PR truth
  refresher" callback that `ExecutionService` uses to keep stored run PR
  snapshots honest.
- [`StudioIssueTemplateService`](../../src/modules/github/studio-issue-template.service.ts)
  — reads `.github/ISSUE_TEMPLATE/*.md`, infers kind from user message,
  exposes a planning-context document so the planner can draft richer
  issues.

### Reconciliation / Settings / Health
- [`ReconciliationService`](../../src/modules/reconciliation/reconciliation.service.ts)
  — predicted vs actual file comparisons, overlap detection, drift
  patterns. Reads completed runs from `ExecutionService.listRecentRuns()`.
- [`SettingsService`](../../src/modules/settings/settings.service.ts)
  + [`ModelRegistryService`](../../src/modules/settings/model-registry.service.ts)
  — persisted repos, default branches, and a user-selected pi model.
- [`HealthService`](../../src/modules/health/health.service.ts) — liveness
  at `GET /health`.

---

## 5. The work item state machine (HSM)

ADR 015 moves the work item lifecycle into a SCION-interpreted SCXML
chart, [`work-item.scxml`](../../src/modules/graph/work-item.scxml).
See **`components/06-hsm-state-chart.puml`** for a reviewer-friendly
rendering, and the canonical chart render at
[`docs/architecture/work-item-state-chart.svg`](../../docs/architecture/work-item-state-chart.svg).

High-level shape:

- A `pre_pr` composite state contains `planned`, `drafting`, `ready`,
  `in_progress`, and `run_errored`. Shared transitions at the parent
  handle `gh.pr_opened`, `user.cancel`, `user.defer` for every substate.
- `deferred` uses SCXML shallow history (`pre_pr_history`) to resume the
  exact substate the work item was in.
- `open_pr → merged_pr → done | archived` handles the post-PR
  disposition. `closed` is a sibling post-PR path for issues closed
  without a merge.
- `done`, `archived`, `cancelled` are final states.

Every state mutation goes through `WorkItemHsmService.dispatch(id, event)`.
The only write that bypasses the HSM is
`WorkItemsService.unsafeSetState(id, state, reason)` — a logged escape
hatch kept for migration scripts. Graph mutations that try to patch
`state` via `update_work_item` are rejected at the controller layer.

Action handlers the service registers at init time:

- `closeGhIssue` — on `user.finalize` / `user.archive_and_finalize` from
  `merged_pr`, calls `GitHubService.closeIssue` and surfaces the result
  via `handler_data` + write-through to the batch cache.
- `runArchiver` — on `user.archive_and_finalize`, moves the plan dir to
  `archives/<slug>/`, archives terminal run dirs, renders a README, and
  stamps `meta.studio_archive` via `patch_overrides`.

Action handlers the chart references but that the service currently
handles via its own code path (not via `registerActionHandler`):

- `createRunRecord` on `user.dispatch` — the actual run record is created
  inline in `ExecutionService.launch()`.
- `stampMeta:*` entries — parsed and applied inline by
  `WorkItemHsmService.applyAction` (no handler needed; the meta is
  persisted as part of the same mutation batch).
- `rememberHistory` on `user.defer` — also inline in
  `WorkItemHsmService.applyAction`, stores `meta.studio_hsm.deferred_from_state`.

---

## 6. Frontend structure

See **`components/04-frontend-structure.puml`**.

One Svelte `App.svelte` hosts four tabs via a left activity bar:

1. **Planning** — three resizable columns: `PlannerChatAdapter` (root
   planner conversation + approval overlay), `GraphView` (D3 via
   `dagre-d3-es`), and `Sidebar` (selected node details + plan actions +
   edge CRUD + create form). `FiltersToolbar` on top and
   `GraphNodeContextMenu` on right-click.
2. **Execute** — `ExecutionDispatchPanel` hosts dispatch list, detail
   pane, run pill strip, checklist, archived bundles, disambiguation
   gate, and follow-up composer.
3. **Reconcile** — `ReconciliationPanel` shows predicted-vs-actual file
   reports.
4. **Settings** — `SettingsPanel` manages repos, default branches, pi
   model selection, and server config.

All network calls go through [`web/src/lib/api.js`](../../web/src/lib/api.js).
Two SSE connections are live: `/api/agent/stream` for planner events
(`planner-chat.js`) and `/api/execution/stream` for execution events
(inline in `ExecutionDispatchPanel.svelte`). A third SSE connection at
`/api/graph/stream` fires on work item state changes and triggers a
debounced graph refresh in `App.svelte`.

Pure logic that is unit-tested lives in
[`web/src/lib/graph-node-actions.js`](../../web/src/lib/graph-node-actions.js)
and is imported from the Vitest tests in `src/__tests__/`. That's the
only frontend-side code that runs in the Node test environment.

---

## 7. Key flows

Each of these has its own sequence diagram. Read the diagrams first and
come back here for the narrative.

### 7.1 Plan lifecycle (`sequences/01-plan-lifecycle.puml`)

A work item starts as `planned`. The operator (or planner chat) triggers
`POST /api/plans/:id/prepare`. `PlansService.prepare` asserts the
preparable state, runs `PlanDrafterService.draft` (a one-shot pi agent
session that loads the `setup-work` skill, inspects the repo, and returns
a JSON envelope), injects the envelope into the canonical scratchpad
template, writes `plans/<slug>/SCRATCHPAD_<slug>.md`, and dispatches
`user.start_draft` through the HSM so the state moves to `pre_pr.drafting`.
A subsequent `POST /api/plans/:id/approve` extracts the final `Affected
Files` section, refines `predicted_files`, dispatches `draft.completed` to
move the work item to `pre_pr.ready`, and records approver metadata.
`POST /api/plans/:id/reopen` inverts this last step.

### 7.2 Execution run (`sequences/02-execution-run.puml`)

`POST /api/execution/launch` takes a `work_item_id`. `ExecutionService.launch`
resolves launch eligibility (dispatch plan membership + launchable state +
safety checks), runs `markWorkItemInProgressOnLaunch` which dispatches
`user.dispatch` to the HSM (moving the state to `pre_pr.in_progress`),
creates a run record, persists metadata, and fires off `executeRun` on a
background promise. `executeRun` does the heavy lifting:

1. `git worktree add` under `worktrees/<branch>/`, `npm ci` for
   dependencies, read project context from `AGENTS.md` / `CLAUDE.md`.
2. `writeScratchpad` — copies the canonical scratchpad into the worktree.
   Source is `canonical_ready` when the plan was approved; otherwise
   `carried_forward` or `synthesized`.
3. Create a pi `createAgentSession` against the worktree with full coding
   tools.
4. **Setup phase** (skipped when `canonical_ready` unless there are open
   clarifications/blockers) — prompt the agent to refine the scratchpad,
   flip run status to `disambiguating`, block on
   `POST /api/execution/resolve-disambiguation`.
5. **Do-work phase** — prompt the agent to implement the checklist,
   committing per task. Scratchpad edits are synced back to canonical at
   each phase boundary.
6. On completion: `git status --short` → `changed_files`,
   `actual_files_sync` on the work item, write `summary.md`, emit
   `execution_result`. `POST /api/execution/pull-request` can be called
   next to auto-commit + push + `gh pr create`; that dispatches
   `gh.pr_opened` through the HSM (`pre_pr.in_progress → open_pr`).

### 7.3 Graph mutation approval (`sequences/03-graph-mutation-approval.puml`)

The root planner calls `propose_mutations` (or `github_create_issue`,
which auto-stages an equivalent proposal). `PlanningService` normalizes
the envelope, stores it in memory under `proposals`, emits a
`mutation_proposal` SSE event. The browser's `PlannerChatAdapter`
receives it, renders each mutation as a selectable card, and the user
approves a subset. `POST /api/agent/proposals/approve` routes through
`PlanningService.approveProposal → GraphWriterService.apply`. If the
batch applies successfully, the service emits `graph_commit_result`, the
browser updates, and `App.svelte` triggers a graph refresh via the
parent `on:graphChanged` event.

### 7.4 Memory and GitHub sync approval
(`sequences/04-memory-write-approval.puml`, `sequences/05-github-sync-approval.puml`)

Structurally identical to the graph mutation flow, but with
`memory_write` / `github_sync` as the staging tool, and
`MemoryService.applyChange` / `GitHubService.applySyncProposal` as the
applier. Both honor optimistic concurrency: memory via SHA-1 content hash,
GitHub via managed-block body hash.

### 7.5 Merged-PR disposition (`sequences/06-merged-pr-disposition.puml`)

Once a PR for an `open_pr` work item is merged, the GH cache sweep detects
it and dispatches `gh.pr_merged` (moving the state to `merged_pr`).
The operator then picks a disposition:

- **Close** (`POST /api/execution/close-merged`) — dispatch
  `user.finalize`. The SCXML `closeGhIssue` action handler fires, closing
  the GitHub issue and caching the closed state. The HSM writes
  `state = done`. `removeRunsForWorkItem` splices matching runs out of
  `recentRuns` and stamps `disposed_at` on each `status.json`.
- **Archive and close** (`POST /api/execution/archive-and-close-merged`)
  — dispatch `user.archive_and_finalize`. Both `closeGhIssue` and
  `runArchiver` fire; the archiver captures a run snapshot, moves the
  plan dir to `archives/<slug>/`, moves terminal run dirs into
  `archives/<slug>/runs/`, renders `archives/<slug>/README.md`, and
  stamps `meta.studio_archive` via `patch_overrides`. HSM writes
  `state = archived`.

Both return a response envelope with the updated work item, closed
issue summary, removed run ids, and a fresh `dispatch_preview`.

### 7.6 Cancel work item (`sequences/07-cancel-work-item.puml`)

`POST /api/work-items/:id/transition` with `event: user.cancel`
delegates to `ExecutionService.cancelWorkItem`. The service closes the
GitHub issue with an optional note, moves the plan dir to
`archives/<slug>/`, dispatches `user.cancel` through the HSM (the chart
allows this transition from every pre-PR substate), and writes
`archive_path` on the work item. Guarded by an active-run check.

### 7.7 GitHub cache sweep (`sequences/08-github-cache-sweep.puml`)

`GitHubCacheScheduler.handleTick` fires every minute. For each repo
owned by a reconcilable work item, it invalidates the batch cache,
refetches PR + issue lists, and walks work items in dispatch source
states. For each, it compares local state to cached GH state and
dispatches `gh.pr_opened` / `gh.pr_merged` / `gh.issue_closed` through
the HSM when the chart allows the advance. The same code path is
exposed on-demand at `POST /api/github-cache/refresh`.

### 7.8 Startup reconciliation (`sequences/09-startup-reconcile.puml`)

`ExecutionService.onModuleInit` runs before the HTTP listener starts.
It calls `WorkItemReconcilerService.runStartupReconcile`, which first
invokes `detectAndMarkOrphans` (scans `runs/<id>/status.json`, rewrites
any `queued`/`preparing`/`disambiguating`/`running` run to `status = error`
with an orphan activity log entry), then runs `reconcile()` to derive a
`next_action` view per work item, logs a summary, and returns. Then
`hydrateRecentRunsFromDisk` loads the newest `status.json` snapshots into
the in-memory `recentRuns` buffer. Finally the service registers SCXML
action handlers. All steps tolerate IO errors without blocking boot.

### 7.9 Sub-agent delegation (`sequences/10-subagent-delegation.puml`)

The root planner calls `delegate_subagent` with an `agent_type`
(`code-crawler` / `scope-predictor` / `reconciliation-analyst`) and a
narrow task. `SubAgentService` creates a new ephemeral pi session scoped
to `process.cwd()` with read-only `Read` / `Grep` / `Bash` tools, prompts
it to return a structured JSON envelope matching
`SubAgentResultEnvelope`, parses the result, and writes per-run
artifacts under `runs/sub_<ts>/`. Status updates stream to the browser
via `subagent_status` / `subagent_result` SSE events.

---

## 8. Source-of-truth pointers

- **SCXML chart** — [`src/modules/graph/work-item.scxml`](../../src/modules/graph/work-item.scxml)
- **Filesystem layout helpers** — [`src/lib/context-layout.ts`](../../src/lib/context-layout.ts)
- **Planner tools** — [`src/modules/planning/planning.service.ts`](../../src/modules/planning/planning.service.ts)
- **Execution core** — [`src/modules/execution/execution.service.ts`](../../src/modules/execution/execution.service.ts)
- **Plan lifecycle** — [`src/modules/plans/plans.service.ts`](../../src/modules/plans/plans.service.ts)
- **GitHub wrapper** — [`src/modules/github/github.service.ts`](../../src/modules/github/github.service.ts)
- **HSM runtime** — [`src/modules/graph/work-item-hsm.service.ts`](../../src/modules/graph/work-item-hsm.service.ts)
- **ADRs** — [`docs/adr/`](../adr/)
- **Contracts** — [`docs/contracts/`](../contracts/)

When a diagram disagrees with the code, the code wins. Update the
diagram; don't let this document ossify.
