# Phase 1 — Kill the HSM shadow vocabulary

**Status:** proposed
**Predecessors:** [phase-0-platform-bus.md](phase-0-platform-bus.md)
**Successors:** [phase-2-work-items-controller-command-bus.md](phase-2-work-items-controller-command-bus.md)
**Estimated effort:** 2 days
**Net forwardRef change:** **−1** (11 → 10)

> This doc replaces an earlier "rewrite HsmActionHandlers in place"
> version that was drafted before [`assessment.md`](assessment.md) made
> the runtime wiring explicit. See §4 of the assessment for the full
> diagnosis.

## Motivation

`WorkItemHsmService.registerActionHandler(name, handler)` is the seam
that external modules use to plug side-effect handlers into HSM
dispatch. At runtime, the only registrations come from two inline
closures in
[`execution.service.ts:134`](../../src/modules/execution/execution.service.ts)
and [`:154`](../../src/modules/execution/execution.service.ts) for
`closeGhIssue` and `runArchiver`.

Meanwhile, three shadow pieces exist that look live but aren't:

1. **`src/modules/graph/hsm-action-handlers.ts`** — an `@Injectable()`
   class with five methods (`createRunRecord`, `stampMeta`,
   `closeGhIssue`, `runArchiver`, `kickOffPlanDrafter`). Registered as a
   GraphModule provider, has unit tests, **never called at runtime.**
   Its method signatures (`HsmActionContext → HsmActionResult`) don't
   match the runtime `HsmActionHandler` type
   (`(workItem, event, ctx) => Promise<void>`), so even if it were
   wired up it couldn't be passed to `registerActionHandler` without an
   adapter.
2. **`src/modules/graph/hsm-guard-handlers.ts`** — a class with one
   method `prExistsForBranch`. Registered as a GraphModule provider,
   has unit tests, **never called at runtime.** The guard the SCXML
   chart names (`cond="pr_exists"`) is evaluated by a hardcoded switch
   in [`work-item-hsm.service.ts:314`](../../src/modules/graph/work-item-hsm.service.ts)
   that reads the event payload directly — no registered guards.
3. **`action="createRunRecord"`** on three SCXML transitions in
   [`work-item.scxml`](../../src/modules/graph/work-item.scxml)
   (`user.dispatch` from `planned`/`ready`, `user.retry` from
   `run_errored`). No handler is registered for this action name, so
   it's pushed into `runtime.actions` and silently dropped. Actual run
   creation happens in `ExecutionService.launch()` after the HSM
   transition returns.

The `HsmActionHandlers.kickOffPlanDrafter` method also falsely implies
an SCXML `<invoke>` pathway the chart doesn't have and the runtime
doesn't interpret. Real plan drafting is synchronous inside
`PlansService.prepare`.

Result: new contributors read the class names and conclude the
handlers are the live path. They're not. The inline closures in
`ExecutionService.onModuleInit` are. This phase makes the live path
named, testable, and single-sourced.

## Scope

**In:**

- Move `hsm-action-handlers.ts` from `src/modules/graph/` to
  `src/modules/execution/`.
- Rewrite its methods to match the runtime `HsmActionHandler` signature
  — mutating `context.handler_data` / `context.patch_overrides` /
  `context.meta` in place, returning `Promise<void>`.
- Add `implements OnModuleInit` and do the `registerActionHandler` calls
  from the class's own `onModuleInit`.
- Delete the inline closures from `ExecutionService.onModuleInit`
  (lines 134–198).
- Delete `HsmActionHandlers.createRunRecord` and the
  `action="createRunRecord"` references from `work-item.scxml`.
- Delete `HsmActionHandlers.kickOffPlanDrafter`.
- Delete `src/modules/graph/hsm-guard-handlers.ts` entirely and its
  test file.
- Remove `HsmActionHandlers` and `HsmGuardHandlers` from
  `graph.module.ts` providers and exports.
- Add the moved `HsmActionHandlers` to `execution.module.ts` providers.
- Rewrite `graph/__tests__/hsm-action-handlers.test.ts` (move and
  adapt) to exercise the new signatures AND assert
  `registerActionHandler` was called on construction.
- Verify the chart parser still accepts the edited `work-item.scxml`
  and the allowlist test at
  [`src/__tests__/state-machine-allowlist.test.ts`](../../src/__tests__/state-machine-allowlist.test.ts)
  passes.

**Out:**

- No changes to `ExecutionService.createHsmRunRecord` (it becomes
  orphaned but is not deleted — Phase 4 addresses it).
- No SCXML `<invoke>` implementation. Plan drafting stays synchronous.
  Making it async is a behavioural change, not a refactor.
- No change to the `stampMeta:*` or `rememberHistory` actions — they're
  already handled inline in `WorkItemHsmService.applyAction` and
  that's fine.
- No command bus usage yet. Phase 1 is a relocation, Phase 2 is the
  first bus consumer.

## File changes

### 1. `src/modules/execution/hsm-action-handlers.ts` (new, replaces graph/)

Target shape:

```typescript
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { GitHubService } from "../github/github.service.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";
import { ExecutionService } from "./execution.service.js";
import { archiveRunArtifactsForWorkItem } from "./run-archiver.js";
import type {
  HsmActionHandlerContext,
  WorkItemHsmEvent,
  WorkItemRecord,
} from "../graph/types.js";

@Injectable()
export class HsmActionHandlers implements OnModuleInit {
  constructor(
    @Inject(WorkItemHsmService) private readonly hsm: WorkItemHsmService,
    @Inject(GitHubService) private readonly github: GitHubService,
    @Inject(GitHubBatchCache) private readonly cache: GitHubBatchCache,
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  onModuleInit(): void {
    this.hsm.registerActionHandler("closeGhIssue",
      (wi, ev, ctx) => this.closeGhIssue(wi, ev, ctx));
    this.hsm.registerActionHandler("runArchiver",
      (wi, ev, ctx) => this.runArchiver(wi, ev, ctx));
  }

  async closeGhIssue(
    workItem: WorkItemRecord,
    _event: WorkItemHsmEvent,
    ctx: HsmActionHandlerContext,
  ): Promise<void> {
    if (workItem.kind !== "issue" || !workItem.repo || !workItem.issue_number) {
      return;
    }
    const details = await this.github.closeIssue(workItem.repo, workItem.issue_number);
    ctx.handler_data.closed_issue = {
      repo: details.repo,
      number: details.number,
      url: details.url,
      title: details.title,
      state: details.state,
    };
    this.cache.upsertIssue(workItem.repo, {
      number: details.number,
      state: "closed",
      closed_at: new Date().toISOString(),
      url: details.url,
      title: details.title,
    });
  }

  async runArchiver(
    workItem: WorkItemRecord,
    _event: WorkItemHsmEvent,
    ctx: HsmActionHandlerContext,
  ): Promise<void> {
    const runs = this.execution.captureRunSnapshotForWorkItem(workItem.id);
    const move = this.execution.movePlanDirToArchives(workItem.id);
    const result = archiveRunArtifactsForWorkItem(
      this.execution.getArtifactRoot(),
      workItem,
      { runs, onWarn: (m) => this.execution.logWarn(m) },
    );
    const archivePath = result.archive_path ?? move.archive_path ?? workItem.archive_path;
    ctx.meta.studio_archive = {
      archived_at: new Date().toISOString(),
      readme_path: result.readme_path,
      archived_run_ids: result.archived_run_ids,
      skipped_run_ids: result.skipped_run_ids,
    };
    ctx.patch_overrides.archive_path = archivePath;
    ctx.handler_data.archive_result = {
      archive_path: archivePath,
      readme_path: result.readme_path,
      archived_run_ids: result.archived_run_ids,
      skipped_run_ids: result.skipped_run_ids,
    };
  }
}
```

`captureRunSnapshotForWorkItem`, `movePlanDirToArchives`,
`getArtifactRoot`, `logWarn` are exposed as public methods on
`ExecutionService` in this phase (currently private). Phase 3 moves the
real logic into `RunDispositionService` proper and these temporary
seams disappear.

### 2. `src/modules/execution/execution.service.ts`

Delete the inline closures. `onModuleInit` becomes:

```typescript
async onModuleInit(): Promise<void> {
  try {
    await this.workItemReconciler.runStartupReconcile();
  } catch (error) {
    this.logger.warn(`Startup reconcile failed: ${this.getErrorMessage(error)}`);
  }
  try {
    this.hydrateRecentRunsFromDisk();
  } catch (error) {
    this.logger.warn(`Failed to hydrate recentRuns: ${this.getErrorMessage(error)}`);
  }
}
```

Drop `private` on `captureRunSnapshotForWorkItem` and
`movePlanDirToArchives`. Add `getArtifactRoot()` and `logWarn(msg)`.
Mark the whole block `// TODO(phase-3): move to RunDispositionService`.

### 3. `src/modules/graph/work-item.scxml`

```diff
- <transition event="user.dispatch" target="in_progress" action="createRunRecord" />
+ <transition event="user.dispatch" target="in_progress" />
```

Three transitions get the same edit. Add a top-of-file comment:
`<!-- Run creation is owned by ExecutionService.launch, not by any -->`
`<!-- SCXML action. -->`

### 4. `src/modules/graph/graph.module.ts`

Remove the HsmActionHandlers / HsmGuardHandlers imports. Remove them
from `providers` and `exports`. Remove `forwardRef(() => GitHubModule)`
from `imports`. Result:

```typescript
@Module({
  imports: [forwardRef(() => ExecutionModule), forwardRef(() => PlansModule)],
  controllers: [WorkItemsController, EdgesController, GraphController],
  providers: [
    SQLiteService, WorkItemsService, EdgesService, GraphService,
    GraphEventsService, GraphWriterService, WorkItemHsmService,
  ],
  exports: [
    SQLiteService, WorkItemsService, EdgesService, GraphService,
    GraphEventsService, GraphWriterService, WorkItemHsmService,
  ],
})
export class GraphModule {}
```

### 5. `src/modules/execution/execution.module.ts`

Add `HsmActionHandlers` to `providers`. No change to `imports` — the
class's dependencies all resolve through existing imports.

### 6. Deletions

- `src/modules/graph/hsm-guard-handlers.ts`
- `src/modules/graph/__tests__/hsm-action-handlers.test.ts` (after
  moving surviving cases to `execution/__tests__/`)
- `HsmActionHandlers.createRunRecord`, `.kickOffPlanDrafter`,
  `.stampMeta` (the last one is dead too — meta stamping is handled
  inline in `WorkItemHsmService.applyAction`)

## Tests

**New:**
- `src/modules/execution/__tests__/hsm-action-handlers.test.ts` —
  method behaviour + a construction test: `new HsmActionHandlers(mockHsm, ...)`
  and assert `mockHsm.registerActionHandler` was called twice with
  `"closeGhIssue"` and `"runArchiver"`. Closes the "tests pass without
  wiring" gap.

**Modified:**
- `src/__tests__/state-machine-allowlist.test.ts` — update expected
  action list to drop `createRunRecord`.
- `src/modules/graph/__tests__/work-item-hsm.service.test.ts` — remove
  any case that assumed `createRunRecord` was a registered handler.

**Deleted:**
- The `HsmGuardHandlers` describe block (file deletion)
- `HsmActionHandlers.createRunRecord` / `kickOffPlanDrafter` test cases

## Acceptance criteria

- [ ] `src/modules/graph/hsm-action-handlers.ts` does not exist
- [ ] `src/modules/graph/hsm-guard-handlers.ts` does not exist
- [ ] `src/modules/execution/hsm-action-handlers.ts` exists, implements
      `OnModuleInit`, methods match the runtime `HsmActionHandler`
      signature
- [ ] `ExecutionService.onModuleInit` contains no `registerActionHandler`
      calls (verify by grep)
- [ ] `work-item.scxml` contains no `action="createRunRecord"` (verify
      by grep)
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` sums to **10**
- [ ] `npm test` passes
- [ ] Server boots, `POST /api/execution/launch` succeeds end-to-end,
      `POST /api/execution/archive-and-close-merged` succeeds end-to-end
      (manual smoke per README)
- [ ] A new test asserts `registerActionHandler` was called twice on
      construction of the moved `HsmActionHandlers`

## Known remaining drift

- `ExecutionService` now has temporary public methods
  (`captureRunSnapshotForWorkItem`, `movePlanDirToArchives`,
  `getArtifactRoot`, `logWarn`) used as injection seams. Phase 3
  deletes them.
- `ExecutionService.createHsmRunRecord` is orphaned. `TODO(phase-4)`
  marker pending the extraction pass.
- The SCXML chart still has a `user.resolve_disambiguation` transition
  from `run_errored → ready` but nothing dispatches it. Phase 9 cleans
  up.

## Next

[Phase 2](phase-2-work-items-controller-command-bus.md) routes
`WorkItemsController` through the command bus, removing the two
remaining forwardRefs from `graph.module.ts` (Execution and Plans) and
producing the first real consumer of the command bus installed in
Phase 0.
