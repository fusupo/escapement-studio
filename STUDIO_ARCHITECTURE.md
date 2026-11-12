# Escapement Studio Architecture

## Runtime and transport

Studio is a Node.js application (22.19+) with a NestJS API and a Svelte 5/Vite
frontend. D3 renders the dependency graph. REST handles requests and snapshots;
SSE carries planner, graph and execution updates. SQLite stores the work graph
and settings. The pi coding-agent SDK runs planner, specialist and coding sessions.

`src/main.ts` boots `AppModule`. `src/config.ts` defines the API port, manifest
path, planner-session directory and external artifact root. Vite proxies `/api`
and `/health` to the configured API URL during development.

## Backend responsibilities

| Module | Owns |
| --- | --- |
| `platform` | Global SQLite infrastructure and Nest CQRS command/event/query buses |
| `graph` | Work items, edges, atomic versioned mutations, graph queries, SCXML lifecycle and graph SSE |
| `planning` | Persistent root planner session, context, ten tool factories, staged proposals, memory and specialist delegation |
| `plans` | Bounded specialist preparation, scratchpad drafting, review/approval metadata and reopening plans |
| `execution` | Launch eligibility, isolated worktrees, durable runs, refinement/confirmation, coding, PRs, disposition and recovery |
| `github` | GitHub CLI operations, issue templates, cached issue/PR truth and scheduled refresh |
| `drift-report` | Predicted-versus-actual file comparisons (the API retains `/api/reconciliation`) |
| `settings` | Repository configuration, model registry and model selection |
| `health` | API/database health |

Cross-workflow commands and domain events use `@nestjs/cqrs`. The completed CQRS
migration removed module-level `forwardRef` cycles; direct feature imports still
exist. The proposal documents describe migration history and targets, rather
than implying that every call is already a bus message.

ExecutionService orchestrates RunStore, LaunchEligibilityService,
RunRefinementService, RunInteractionService, ScratchpadService, WorktreeService,
PullRequestService and WorkItemReconcilerService. RunDispositionService owns
close/archive/cancel/delete flows. Follow the size and responsibility conventions
in `CLAUDE.md` when extending these services.

## Lifecycle and persistence boundaries

`src/modules/graph/work-item.scxml` is the canonical work-item lifecycle.
WorkItemHsmService dispatches events and executes registered side effects before
writing a transition. Work-item lifecycle state is separate from each execution
attempt's run status. Public update endpoints reject direct lifecycle changes;
internal HSM writes share the graph writer's validated mutation path.

A plan is drafted and approved before dispatch. Launch creates an isolated Git
worktree and a durable run. Dependency installation is asynchronous and bounded,
so the API can continue serving requests and SSE while npm runs. Worktree
refinement then persists an explicit confirmation checkpoint before coding.
Confirmation responses and run artifacts survive restarts; orphaned live agent
sessions are reconciled into actionable run records.

Graph mutation input is validated before sorting, snapshot simulation and SQL
construction. Only explicitly allowed DTO fields can become SQL columns. Graph
commits apply within a SQLite transaction and increment `graph_version`.
The work-item schema migration uses a version marker in `studio_metadata`; its
strict table copy, index/trigger restoration and marker commit atomically.

| Storage | Contents |
| --- | --- |
| `.manifest/manifest.db` | Canonical work items/edges, graph version, settings and schema migration metadata |
| `.studio/planning/sessions/` | Persistent planner conversation |
| `PLANNING_MEMORY.md` | Approved planning memory |
| `<artifact-root>/plans/<slug>/` | Canonical scratchpad and plan metadata |
| `<artifact-root>/runs/<run-id>/` | Run status, activity, outputs and other attempt artifacts |
| `<artifact-root>/worktrees/` | Isolated execution checkouts |
| `<artifact-root>/archives/<slug>/` | Archived work-item/run bundles |

`src/lib/context-layout.ts` owns artifact path construction. The default artifact
root is `/home/marc/escapement-studio-ctx`; override it with `ARTIFACT_ROOT`.
Closed runs can retain artifacts while a `disposed_at` marker excludes them from
recent runs. Archive-and-close preserves bundles for the archived-history UI.

## Frontend responsibilities

`App.svelte` composes navigation, the active workspace, dialogs and status.
`ExecutionDispatchPanel.svelte` composes dispatch, details, run content and
confirmation. Both are intentionally small composition components.

| Area | Components / controllers |
| --- | --- |
| Navigation/status | ActivityBar, WorkspaceStatusBar |
| Planning layout/graph | PlanningViewport, GraphView, Sidebar, GraphActionsMenu |
| Plan/disposition dialogs | PlanReviewDialog, WorkItemDispositionDialogs; shared modal focus action |
| Planning state and lifecycle | `lib/planning/workspace.svelte.js` |
| Planning data/actions | `graph-data.js`, `plan-actions.js`, `work-item-actions.js`, `pane-interactions.js` |
| Execution content | ExecutionRunWorkspace, ExecutionActivityFeed, ExecutionConfirmationDrawer, existing dispatch/detail/checklist/archive components |
| Execution state and lifecycle | `lib/execution/workspace.svelte.js` |
| Execution data/actions | `run-data.js`, `run-actions.js`, `refinement-actions.js`, `activity.js` |
| Planner chat | PlannerChatAdapter and `lib/planner-chat.js` |

The workspace factories create component-scoped Svelte reactive state and attach
focused action factories. Effects and mount cleanup belong to the lifecycle
controllers. Execution sync still uses `execution-sync.js` for coalescing reloads
on reconnect/focus; checklist freshness and refinement draft projection remain
separate helpers. Views consume typed controller contracts and preserve UI state
through those controllers. DOMPurify sanitizes parsed Markdown before `@html`.

## Verification and contracts

`npm run check` checks the backend; `npm run check:web` checks frontend JavaScript,
Svelte and typed API/component boundaries. `npm test` runs unit/regression tests;
`npm run test:web` runs desktop browser workflows against an isolated mock
API. Those browser tests do not start agents or modify GitHub/live artifact data.

`docs/contracts/` defines mutation proposals, graph commits, SSE, memory, GitHub
sync, specialist responses, plan/run lifecycle and artifact formats. ADRs 014 and
015 document the plan/run split and work-item HSM. For actual transition behavior,
read the SCXML; older proposal diagrams are historical context.
