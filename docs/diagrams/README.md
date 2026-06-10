# Diagrams

Current-state PlantUML diagrams for orientation. The older set (from before
ADR 014 and ADR 015) was removed; these replace it.

Render with any PlantUML tool, e.g.:

```bash
plantuml docs/diagrams/components/*.puml docs/diagrams/sequences/*.puml
```

## Components

- [`01-system-overview.puml`](components/01-system-overview.puml) — browser / API / storage / external services at a glance.
- [`02-backend-modules.puml`](components/02-backend-modules.puml) — NestJS modules and the `@Module` import edges between them (global `PlatformModule` at the top).
- [`03-execution-internals.puml`](components/03-execution-internals.puml) — `ExecutionModule` broken down: orchestrators, sub-services, pure helpers, CQRS handlers, reconciler.
- [`04-planning-internals.puml`](components/04-planning-internals.puml) — `PlanningModule`: `PlanningService` + context / memory / sub-agent / proposal-state services + the 10 custom tools.
- [`05-filesystem-layout.puml`](components/05-filesystem-layout.puml) — the artifact context root layout (`plans/`, `runs/`, `worktrees/`, `archives/`) per ADR 014.
- [`06-hsm-state-chart.puml`](components/06-hsm-state-chart.puml) — the ADR 015 work-item lifecycle declared in `src/modules/graph/work-item.scxml` (composite `pre_pr`, deferred history, terminal states, action handlers).

## Sequences

- [`01-plan-lifecycle.puml`](sequences/01-plan-lifecycle.puml) — `POST /api/plans/.../prepare|approve|reopen` and the HSM transitions they drive.
- [`02-execution-run.puml`](sequences/02-execution-run.puml) — `POST /api/execution/launch` through worktree + setup phase + disambiguation gate + do-work phase + completion.
- [`03-mutation-approval.puml`](sequences/03-mutation-approval.puml) — planner chat turn → `propose_mutations` tool → staged proposal → `POST /api/agent/proposals/approve` → `GraphWriterService.apply`. Memory and GitHub sync approvals follow the same shape.
- [`04-merged-pr-disposition.puml`](sequences/04-merged-pr-disposition.puml) — `POST /api/execution/close-merged` (and the archive-and-close variant) flowing through CQRS → `RunDispositionService` → HSM action handlers → `RunStore.disposeRunsForWorkItem`.
- [`05-cache-sweep-hsm.puml`](sequences/05-cache-sweep-hsm.puml) — `GitHubCacheScheduler` `@Cron` tick refreshing `GitHubBatchCache` and auto-dispatching `gh.*` HSM events.
