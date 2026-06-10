# Phase 6 — `PlatformModule` for infrastructure + move `GitHubBatchCache` home

**Status:** proposed
**Predecessors:** [phase-5-event-driven-cross-context.md](phase-5-event-driven-cross-context.md)
**Successors:** [phase-7-planner-tool-registry.md](phase-7-planner-tool-registry.md)
**Estimated effort:** 2 days
**Net forwardRef change:** **−3** (7 → 4)

## Motivation

Two related wrong-home smells, bundled because they share the
"stop GraphModule from being an infrastructure hub" and
"stop ExecutionModule from owning GitHub cache state" goals.

### 6.1 `SQLiteService` is infrastructure, not domain

`SQLiteService` lives in `GraphModule`
([`src/modules/graph/sqlite.service.ts`](../../src/modules/graph/sqlite.service.ts))
but it's a 136-line wrapper around `better-sqlite3` plus a startup
schema migration. Nothing about it is graph-specific. Consumers:

- Same-module: `WorkItemsService`, `GraphWriterService`, `GraphService`,
  `EdgesService`
- Cross-module: `GitHubService` (line 119), `SettingsService` (line 39),
  `HealthService` (line 6), `ContextService` (line 31)

Because it lives in `GraphModule`, any module that needs a DB handle
has to import GraphModule. See [`assessment.md`](assessment.md) §2.2
and §7 — the transitive cycles through Graph are why
`Execution → Settings`, `Plans → Settings`, and `Settings → Graph`
all use defensive `forwardRef`.

Moving `SQLiteService` to a dedicated `PlatformModule` gives
infrastructure a home that no domain module imports, and breaks the
transitive cycles in one go.

### 6.2 `GitHubBatchCache` and `GitHubCacheScheduler` live in ExecutionModule

Both of these live at
[`src/modules/execution/github-batch-cache.service.ts`](../../src/modules/execution/github-batch-cache.service.ts)
and `github-cache-scheduler.service.ts`, plus a
`GitHubCacheController` exposing `POST /api/github-cache/refresh`.
They ended up in ExecutionModule because that's where the first
consumer landed (the HSM action handlers and the reconciler). But
their responsibility is **caching external GitHub state** — which is
a GitHub concern, not an execution concern. `GitHubService` in
`GitHubModule` is their obvious neighbour.

Moving them to `GitHubModule` consolidates "everything that talks to
`gh` CLI" in one place. It also means anyone who wants cached
GitHub data (the work-item reconciler, the HSM action handlers, the
drift report service in Phase 8) imports `GitHubModule` — exactly
the module whose name matches the intent.

## Scope

**In:**

### PlatformModule creation

- Create `src/modules/platform/platform.module.ts` and
  `src/modules/platform/sqlite.service.ts`.
- Move `SQLiteService` verbatim from `graph/` to `platform/`.
- Remove it from `GraphModule`'s providers/exports.
- Add `PlatformModule` to `AppModule.imports`.
- Update every consumer import path:
  - `src/modules/graph/work-items.service.ts`
  - `src/modules/graph/graph-writer.service.ts`
  - `src/modules/graph/graph.service.ts`
  - `src/modules/graph/edges.service.ts`
  - `src/modules/github/github.service.ts`
  - `src/modules/settings/settings.service.ts`
  - `src/modules/health/health.service.ts`
  - `src/modules/planning/context.service.ts`
- Add `PlatformModule` to the `imports` of every module whose
  providers inject `SQLiteService`: `GraphModule`, `GitHubModule`,
  `SettingsModule`, `HealthModule`, `PlanningModule`.

### GitHub cache relocation

- Move the three files from `src/modules/execution/` to
  `src/modules/github/`:
  - `github-batch-cache.service.ts`
  - `github-cache-scheduler.service.ts`
  - `github-cache.controller.ts`
  - (+ their tests in `execution/__tests__/`)
- Remove from `ExecutionModule`'s providers/exports; add to
  `GitHubModule`'s.
- Update import paths in:
  - `src/modules/execution/execution.service.ts`
  - `src/modules/execution/hsm-action-handlers.ts`
  - `src/modules/execution/work-item-reconciler.service.ts`
  - `src/modules/execution/run-disposition.service.ts`
  - `src/modules/execution/pull-request.service.ts`
  - `src/modules/reconciliation/reconciliation.module.ts` and
    service (if it imports the cache)

### ForwardRef cleanup

After the two relocations, walk the module graph and delete every
`forwardRef` that no longer defends a cycle:

- `SettingsModule → forwardRef(GraphModule)` — replaced by
  `SettingsModule → PlatformModule` (direct, no cycle).
- `ExecutionModule → forwardRef(SettingsModule)` — the cycle
  `Execution → Settings → Graph → Execution` is gone. Unwrap.
- `PlansModule → forwardRef(SettingsModule)` — same. Unwrap.
- `HealthModule → GraphModule` — replaced by
  `HealthModule → PlatformModule`. Unwrap (it was a direct import
  before, but drop the GraphModule dependency entirely since
  HealthService only needed SQLite).

Net: **−3 forwardRefs**. Count: **7 → 4.**

**Out:**

- No changes to `SQLiteService`'s behaviour, schema migrations, or
  API.
- No changes to `GitHubBatchCache`'s cache semantics, TTL, or
  write-through updates.
- No new GitHub operations. The cache scheduler's cron schedule and
  event dispatch are unchanged.
- No rename of the module, class, or file — just relocation.

## File changes

### 1. `src/modules/platform/platform.module.ts` (new)

```typescript
import { Module } from "@nestjs/common";
import { SQLiteService } from "./sqlite.service.js";

@Module({
  providers: [SQLiteService],
  exports: [SQLiteService],
})
export class PlatformModule {}
```

### 2. `src/modules/platform/sqlite.service.ts` (new, moved)

Verbatim move from `src/modules/graph/sqlite.service.ts`. Only the
import of `getConfig` updates because the relative path is different.

### 3. `src/modules/graph/graph.module.ts`

```diff
- imports: [forwardRef(() => ExecutionModule), forwardRef(() => PlansModule)],
+ imports: [PlatformModule, forwardRef(() => ExecutionModule), forwardRef(() => PlansModule)],
  providers: [
-   SQLiteService,
    WorkItemsService, EdgesService, GraphService,
    GraphEventsService, GraphWriterService, WorkItemHsmService,
  ],
  exports: [
-   SQLiteService,
    WorkItemsService, EdgesService, GraphService,
    GraphEventsService, GraphWriterService, WorkItemHsmService,
  ],
```

Note: after Phase 1 and 2, `GraphModule` already dropped
`forwardRef(GitHubModule)`, `forwardRef(ExecutionModule)` on the
controller side, and `forwardRef(PlansModule)`. Phase 6 leaves the
remaining forwardRefs on Graph as-is for now — the decisions about
whether to drop them live in Phase 9 cleanup.

Wait — double-check: did Phase 2 remove all of Graph's imports?
Re-reading `assessment.md` §12: Phase 2 removes Graph → Execution
and Graph → Plans. Yes — after Phase 2, Graph has no forwardRefs of
its own. So the imports list above simplifies further. Edit the
diff to match:

```diff
- imports: [],  // (post-Phase 2)
+ imports: [PlatformModule],
```

### 4. `src/modules/github/github.module.ts`

```diff
- imports: [GraphModule],
+ imports: [PlatformModule, GraphModule],
  providers: [
    GitHubService,
    StudioIssueTemplateService,
+   GitHubBatchCache,
+   GitHubCacheScheduler,
  ],
+ controllers: [GitHubController, GitHubCacheController],
  exports: [
    GitHubService,
    StudioIssueTemplateService,
+   GitHubBatchCache,
  ],
```

`GraphModule` stays imported because `GitHubService` still injects
`WorkItemsService` (for `listByRepoIssueNumber` etc.). The
`reconcileIssueTruth` path is graph-shaped, not platform-shaped.

### 5. `src/modules/execution/execution.module.ts`

```diff
- imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), forwardRef(() => PlansModule), forwardRef(() => SettingsModule)],
+ imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), forwardRef(() => PlansModule), SettingsModule],
  providers: [
    ExecutionService,
-   GitHubBatchCache,
-   GitHubCacheScheduler,
    WorkItemReconcilerService,
    HsmActionHandlers,
    RunDispositionService,
    RunStore, WorktreeService, ScratchpadService,
    RunInteractionService, PullRequestService,
  ],
  controllers: [
    ExecutionController,
-   GitHubCacheController,
    WorkItemReconcilerController,
  ],
  exports: [
    ExecutionService,
-   GitHubBatchCache,
-   GitHubCacheScheduler,
    WorkItemReconcilerService,
    RunStore, WorktreeService, ScratchpadService,
    RunInteractionService, PullRequestService,
    RunDispositionService,
  ],
```

Note: `SettingsModule` is now imported directly (no `forwardRef`)
because the `Execution → Settings → Graph → Execution` cycle is
gone — `Settings → Graph` was replaced by `Settings → Platform`.

### 6. `src/modules/plans/plans.module.ts`

```diff
- imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), forwardRef(() => SettingsModule)],
+ imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), SettingsModule],
```

`Plans → Settings` transitive cycle is also broken by PlatformModule.

### 7. `src/modules/settings/settings.module.ts`

```diff
- imports: [forwardRef(() => GraphModule)],
+ imports: [PlatformModule],
```

### 8. `src/modules/health/health.module.ts`

```diff
- imports: [GraphModule],
+ imports: [PlatformModule],
```

HealthService's only dependency on GraphModule was SQLiteService.
With Platform, Health no longer knows about the graph.

### 9. `src/app.module.ts`

```diff
  imports: [
    ScheduleModule.forRoot(),
+   PlatformModule,
    ExecutionModule, GraphModule, HealthModule, GitHubModule,
    PlanningModule, PlansModule, ReconciliationModule, SettingsModule,
  ],
```

## Tests

**New:**
- `src/modules/platform/__tests__/sqlite.service.test.ts` — the
  existing test moves with the file.
- `src/modules/github/__tests__/github-batch-cache.service.test.ts`
  — the existing test moves with the file.

**Modified:**
- Any test that constructs `GraphModule` via `Test.createTestingModule`
  and expected `SQLiteService` to be exported from it. Update to
  import `PlatformModule`.
- Similarly for `ExecutionModule` consumers that expected
  `GitHubBatchCache` in Execution.

## Acceptance criteria

- [ ] `src/modules/platform/platform.module.ts` and
      `sqlite.service.ts` exist
- [ ] `src/modules/graph/sqlite.service.ts` no longer exists
- [ ] `src/modules/execution/github-batch-cache.service.ts`,
      `github-cache-scheduler.service.ts`, and
      `github-cache.controller.ts` no longer exist
- [ ] `GitHubModule` exports `GitHubBatchCache` and provides the
      scheduler
- [ ] `SettingsModule`, `HealthModule` import `PlatformModule` and
      do not import `GraphModule`
- [ ] `ExecutionModule`, `PlansModule` import `SettingsModule`
      directly (no forwardRef)
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` sums to **4**
- [ ] `npm test` passes
- [ ] Server boots; `curl /health` works; `curl /api/github-cache/refresh`
      works (route URL unchanged — the controller moved modules but
      the path is still `/api/github-cache/refresh`)
- [ ] Scheduled `@Cron(EVERY_MINUTE)` sweep still fires correctly
      after the move (observe a log line)

## Known remaining drift

- The four remaining forwardRefs are:
  - `GraphModule → forwardRef(ExecutionModule)`, wait — this was
    removed in Phase 2. Re-verify after Phase 6 lands.
  - After all previous phases + 6: `ExecutionModule → forwardRef(GraphModule)`,
    `ExecutionModule → forwardRef(GitHubModule)`, `ExecutionModule →
    forwardRef(PlansModule)`, `PlansModule → forwardRef(GraphModule)`,
    `PlansModule → forwardRef(GitHubModule)`.
  - That's 5, not 4. Re-check arithmetic during implementation.
    Phase 9 may clean up one more.
- `ReconciliationModule` still imports `ExecutionModule` directly
  for `ExecutionService.listRecentRuns`. Phase 8 revisits this —
  injecting `RunStore` directly after Phase 4/6 lets Reconciliation
  drop its ExecutionModule import.

## Next

[Phase 7](phase-7-planner-tool-registry.md) extracts the 10 planner
tool definitions from the 1378-line `PlanningService` into separate
files with a registry pattern. No forwardRef changes; pure
code-size reduction.
