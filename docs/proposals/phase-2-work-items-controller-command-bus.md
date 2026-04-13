# Phase 2 — Route `WorkItemsController` through the command bus

**Status:** proposed
**Owner:** unassigned
**Predecessors:** [phase-0-platform-bus.md](phase-0-platform-bus.md)
**Successors:** [phase-3-execution-subservices.md](phase-3-execution-subservices.md)
**Estimated effort:** 2 days
**Net forwardRef change:** **−2** (10 → 8)

> The earlier version of this doc claimed −1 (11 → 10) based on the
> assumption that Phase 1 was a "rewrite in place" with no module
> movement. [`assessment.md`](assessment.md) §12 updated Phase 1 to
> move `HsmActionHandlers` out of `GraphModule`, which removes
> `forwardRef(GitHubModule)` from graph's imports (−1). Phase 2 then
> removes `forwardRef(ExecutionModule)` and `forwardRef(PlansModule)`
> from graph's imports as `WorkItemsController` stops injecting those
> services directly (−2).

## Motivation

[`src/modules/graph/work-items.controller.ts`](../../src/modules/graph/work-items.controller.ts)
is the HTTP adapter for `/api/work-items/*`. It sits inside `GraphModule`
but currently injects two services from other modules via `forwardRef`:

```typescript
constructor(
  @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
  @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
  @Inject(forwardRef(() => ExecutionService))
  private readonly executionService: ExecutionService,
  @Inject(forwardRef(() => PlansService))
  private readonly plansService: PlansService,
) {}
```

The cross-module reaches are in `transition()`:

| Line | Call |
|---|---|
| 120 | `this.executionService.cancelWorkItem({...})` |
| 139 | `this.plansService.prepare(id)` |
| 144 | `this.plansService.reopen(id)` |
| 149 | `this.executionService.transitionInProgressToDrafting(id)` |
| 162 | `this.executionService.transitionInProgressToReady(id)` |

These five call sites are why `GraphModule` has `forwardRef(() => ExecutionModule)`
and `forwardRef(() => PlansModule)` in its `imports` (alongside the
`forwardRef(() => GitHubModule)` needed by `HsmActionHandlers`).

Phase 2 replaces every one of those direct injections with a command
dispatched through the Phase 0 command bus. After Phase 2:

- `WorkItemsController` injects only `CommandBus` (+ its existing
  `WorkItemsService` and `WorkItemHsmService`, both in the same module)
- `GraphModule` no longer has a reason to import `PlansModule` — the
  `forwardRef(() => PlansModule)` line comes out of `graph.module.ts`
- `GraphModule → ExecutionModule` forwardRef stays (Phase 1 left
  `HsmActionHandlers` depending on `ExecutionService.runArchiverAction`;
  Phase 3 is the one that finally breaks that)
- `ExecutionController` migrates the same methods to command dispatch
  as a consistency pass, so `/api/execution/*` and `/api/work-items/*`
  both route through the bus for cancel/delete/transition

The five commands (six counting `DeleteWorkItem`, which is exposed only
on `ExecutionController` today) are:

| Command | Handler module | Wraps |
|---|---|---|
| `CancelWorkItemCommand` | `ExecutionModule` | `ExecutionService.cancelWorkItem` |
| `DeleteWorkItemCommand` | `ExecutionModule` | `ExecutionService.deleteWorkItem` |
| `TransitionInProgressToReadyCommand` | `ExecutionModule` | `ExecutionService.transitionInProgressToReady` |
| `TransitionInProgressToDraftingCommand` | `ExecutionModule` | `ExecutionService.transitionInProgressToDrafting` |
| `PreparePlanCommand` | `PlansModule` | `PlansService.prepare` |
| `ReopenPlanCommand` | `PlansModule` | `PlansService.reopen` |

Each handler is a thin wrapper. The logic stays in the existing service
methods; only the invocation path changes. Phase 3 and later extract the
actual logic into smaller pieces. Phase 2 is about **killing the direct
cross-module injection pattern** — moving logic is somebody else's job.

## Scope

**In:**

- Create six command classes + six handler classes (12 new files)
- Register the handlers as providers in `ExecutionModule` / `PlansModule`
- Rewrite `WorkItemsController` to inject `CommandBus` instead of
  `ExecutionService` / `PlansService`
- Rewrite the six corresponding `ExecutionController` routes to dispatch
  via `CommandBus`
- Remove `forwardRef(() => PlansModule)` from `graph.module.ts`
- Rewrite `src/modules/graph/__tests__/work-item-transitions.test.ts`
  to mock `CommandBus` instead of direct service references
- The smoke test from Phase 0
  (`src/platform/__tests__/bus.smoke.test.ts`) can be deleted — this
  phase is the first real consumer of the bus

**Out:**

- **No logic migration.** Handler bodies are a single
  `return await this.xxxService.methodName(command.args);` line. The
  shrinking of the god class is Phase 3/4 work.
- **No changes to `ExecutionService.cancelWorkItem` / `deleteWorkItem` /
  `transitionInProgressToX`** — they stay with identical bodies.
- **No changes to `PlansService.prepare` / `reopen`.**
- **No removal of the `GraphModule → ExecutionModule` forwardRef.**
  `HsmActionHandlers` still needs `ExecutionService.runArchiverAction`
  per Phase 1. Phase 3 removes that dependency.
- **No "cleanup" of defensive forwardRefs elsewhere in the graph**
  (e.g. `PlansModule → GraphModule` could theoretically become a direct
  import once `Graph → Plans` is gone, but that's a Phase 9 cleanup).
- **No frontend changes.** Every existing HTTP route behaves identically.

## File changes

### 1. New command + handler files in `src/modules/execution/application/commands/`

Create the directory `src/modules/execution/application/commands/` (new,
mirrors the Phase 0 conventions).

#### `cancel-work-item.command.ts`

```typescript
import { ICommand } from "@nestjs/cqrs";
import type { CancelWorkItemDto } from "../../types.js";

/**
 * Route CancelWorkItem through the command bus. Dispatched by both
 * WorkItemsController.transition(user.cancel) and
 * ExecutionController.cancelWorkItem.
 *
 * Handler: CancelWorkItemHandler
 * Returns: CancelWorkItemResult
 */
export class CancelWorkItemCommand implements ICommand {
  constructor(public readonly dto: CancelWorkItemDto) {}
}
```

#### `cancel-work-item.handler.ts`

```typescript
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { Inject } from "@nestjs/common";
import { ExecutionService } from "../../execution.service.js";
import type { CancelWorkItemResult } from "../../types.js";
import { CancelWorkItemCommand } from "./cancel-work-item.command.js";

@CommandHandler(CancelWorkItemCommand)
export class CancelWorkItemHandler
  implements ICommandHandler<CancelWorkItemCommand, CancelWorkItemResult>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(command: CancelWorkItemCommand): Promise<CancelWorkItemResult> {
    return await this.execution.cancelWorkItem(command.dto);
  }
}
```

#### `delete-work-item.command.ts`

```typescript
import { ICommand } from "@nestjs/cqrs";
import type { DeleteWorkItemDto } from "../../types.js";

export class DeleteWorkItemCommand implements ICommand {
  constructor(public readonly dto: DeleteWorkItemDto) {}
}
```

#### `delete-work-item.handler.ts`

```typescript
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { Inject } from "@nestjs/common";
import { ExecutionService } from "../../execution.service.js";
import type { DeleteWorkItemResult } from "../../types.js";
import { DeleteWorkItemCommand } from "./delete-work-item.command.js";

@CommandHandler(DeleteWorkItemCommand)
export class DeleteWorkItemHandler
  implements ICommandHandler<DeleteWorkItemCommand, DeleteWorkItemResult>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(command: DeleteWorkItemCommand): Promise<DeleteWorkItemResult> {
    return await this.execution.deleteWorkItem(command.dto);
  }
}
```

#### `transition-in-progress-to-ready.command.ts`

```typescript
import { ICommand } from "@nestjs/cqrs";

export class TransitionInProgressToReadyCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
```

#### `transition-in-progress-to-ready.handler.ts`

```typescript
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { Inject } from "@nestjs/common";
import { ExecutionService } from "../../execution.service.js";
import type { WorkItemRecord } from "../../../graph/types.js";
import { TransitionInProgressToReadyCommand } from "./transition-in-progress-to-ready.command.js";

@CommandHandler(TransitionInProgressToReadyCommand)
export class TransitionInProgressToReadyHandler
  implements ICommandHandler<TransitionInProgressToReadyCommand, WorkItemRecord>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(
    command: TransitionInProgressToReadyCommand,
  ): Promise<WorkItemRecord> {
    return await this.execution.transitionInProgressToReady(command.workItemId);
  }
}
```

#### `transition-in-progress-to-drafting.command.ts` + `.handler.ts`

Mirror of the above, pointing at
`ExecutionService.transitionInProgressToDrafting`.

### 2. New command + handler files in `src/modules/plans/application/commands/`

Create the directory `src/modules/plans/application/commands/`.

#### `prepare-plan.command.ts`

```typescript
import { ICommand } from "@nestjs/cqrs";

export class PreparePlanCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
```

#### `prepare-plan.handler.ts`

```typescript
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { Inject } from "@nestjs/common";
import { PlansService } from "../../plans.service.js";
import type { PlanResponse } from "../../types.js";
import { PreparePlanCommand } from "./prepare-plan.command.js";

@CommandHandler(PreparePlanCommand)
export class PreparePlanHandler
  implements ICommandHandler<PreparePlanCommand, PlanResponse>
{
  constructor(
    @Inject(PlansService) private readonly plans: PlansService,
  ) {}

  async execute(command: PreparePlanCommand): Promise<PlanResponse> {
    return await this.plans.prepare(command.workItemId);
  }
}
```

#### `reopen-plan.command.ts` + `.handler.ts`

Mirror for `PlansService.reopen(workItemId)`.

### 3. Register handlers in `ExecutionModule`

```diff
 import { forwardRef, Module } from "@nestjs/common";
 import { GitHubModule } from "../github/github.module.js";
 import { GraphModule } from "../graph/graph.module.js";
 import { PlansModule } from "../plans/plans.module.js";
 import { SettingsModule } from "../settings/settings.module.js";
 import { ExecutionController } from "./execution.controller.js";
 import { GitHubBatchCache } from "./github-batch-cache.service.js";
 import { GitHubCacheController } from "./github-cache.controller.js";
 import { GitHubCacheScheduler } from "./github-cache-scheduler.service.js";
 import { ExecutionService } from "./execution.service.js";
 import { WorkItemReconcilerController } from "./work-item-reconciler.controller.js";
 import { WorkItemReconcilerService } from "./work-item-reconciler.service.js";
+import { CancelWorkItemHandler } from "./application/commands/cancel-work-item.handler.js";
+import { DeleteWorkItemHandler } from "./application/commands/delete-work-item.handler.js";
+import { TransitionInProgressToReadyHandler } from "./application/commands/transition-in-progress-to-ready.handler.js";
+import { TransitionInProgressToDraftingHandler } from "./application/commands/transition-in-progress-to-drafting.handler.js";

 @Module({
   imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), forwardRef(() => PlansModule), forwardRef(() => SettingsModule)],
   controllers: [ExecutionController, GitHubCacheController, WorkItemReconcilerController],
-  providers: [ExecutionService, GitHubBatchCache, GitHubCacheScheduler, WorkItemReconcilerService],
-  exports: [ExecutionService, GitHubBatchCache, GitHubCacheScheduler, WorkItemReconcilerService],
+  providers: [
+    ExecutionService,
+    GitHubBatchCache,
+    GitHubCacheScheduler,
+    WorkItemReconcilerService,
+    CancelWorkItemHandler,
+    DeleteWorkItemHandler,
+    TransitionInProgressToReadyHandler,
+    TransitionInProgressToDraftingHandler,
+  ],
+  exports: [ExecutionService, GitHubBatchCache, GitHubCacheScheduler, WorkItemReconcilerService],
 })
 export class ExecutionModule {}
```

Handlers do NOT go in `exports` — they are discovered by
`@nestjs/cqrs` via metadata scanning during `onApplicationBootstrap`, not
via imports from other modules. Only services that other modules still
need to inject directly remain in `exports`.

### 4. Register handlers in `PlansModule`

```diff
 import { forwardRef, Module } from "@nestjs/common";
 import { GitHubModule } from "../github/github.module.js";
 import { GraphModule } from "../graph/graph.module.js";
 import { SettingsModule } from "../settings/settings.module.js";
 import { PlanDrafterService } from "./plan-drafter.service.js";
 import { PlansController } from "./plans.controller.js";
 import { PlansService } from "./plans.service.js";
+import { PreparePlanHandler } from "./application/commands/prepare-plan.handler.js";
+import { ReopenPlanHandler } from "./application/commands/reopen-plan.handler.js";

 @Module({
   imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), forwardRef(() => SettingsModule)],
   controllers: [PlansController],
-  providers: [PlansService, PlanDrafterService],
+  providers: [PlansService, PlanDrafterService, PreparePlanHandler, ReopenPlanHandler],
   exports: [PlansService, PlanDrafterService],
 })
 export class PlansModule {}
```

### 5. Rewrite `WorkItemsController`

Remove the two cross-module `forwardRef` injections and replace with
`CommandBus`. The `transition()` method becomes a dispatcher.

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { CancelWorkItemCommand } from "../execution/application/commands/cancel-work-item.command.js";
import { TransitionInProgressToDraftingCommand } from "../execution/application/commands/transition-in-progress-to-drafting.command.js";
import { TransitionInProgressToReadyCommand } from "../execution/application/commands/transition-in-progress-to-ready.command.js";
import { PreparePlanCommand } from "../plans/application/commands/prepare-plan.command.js";
import { ReopenPlanCommand } from "../plans/application/commands/reopen-plan.command.js";
import type { CancelWorkItemResult } from "../execution/types.js";
import type {
  CreateWorkItemDto,
  UpdateWorkItemDto,
  WorkItemHsmEvent,
  WorkItemRecord,
} from "./types.js";
import { WorkItemHsmService } from "./work-item-hsm.service.js";
import { WorkItemsService } from "./work-items.service.js";

interface TransitionDto {
  event: WorkItemTransitionEvent;
  confirm_cancel?: boolean;
  cancel_note?: string;
}

type WorkItemTransitionEvent =
  | "user.start_draft"
  | "user.investigate"
  | "user.defer"
  | "user.undefer"
  | "user.cancel";

const SUPPORTED_TRANSITION_EVENTS = new Set<WorkItemTransitionEvent>([
  "user.start_draft",
  "user.investigate",
  "user.defer",
  "user.undefer",
  "user.cancel",
]);

@Controller("api/work-items")
export class WorkItemsController {
  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    private readonly commandBus: CommandBus,
  ) {}

  // ... unchanged list/get/create/update/delete methods ...

  @Post(":id/transition")
  async transition(
    @Param("id") id: string,
    @Body() body: TransitionDto,
  ): Promise<WorkItemRecord | CancelWorkItemResult> {
    const eventType = body?.event;
    if (!eventType) {
      throw new BadRequestException("transition event `event` is required");
    }

    const workItem = this.workItems.get(id);
    if (!SUPPORTED_TRANSITION_EVENTS.has(eventType)) {
      throw new BadRequestException(
        `Unsupported work-item transition event: ${eventType}`,
      );
    }

    const enabledEvents = new Set(this.hsmService.getEnabledEvents(id));
    if (!enabledEvents.has(eventType)) {
      throw new BadRequestException(
        `HSM event ${eventType} is not enabled from state ${workItem.state}`,
      );
    }

    switch (eventType) {
      case "user.start_draft":
        await this.routeStartDraft(id, workItem);
        break;
      case "user.investigate":
        await this.routeInvestigate(id, workItem);
        break;
      case "user.defer":
      case "user.undefer":
        await this.hsmService.dispatch(id, { type: eventType });
        break;
      case "user.cancel":
        return await this.commandBus.execute<CancelWorkItemCommand, CancelWorkItemResult>(
          new CancelWorkItemCommand({
            work_item_id: id,
            confirm_cancel: body.confirm_cancel === true,
            cancel_note: body.cancel_note,
          }),
        );
    }

    return this.workItems.get(id);
  }

  // ... unchanged delete method ...

  private async routeStartDraft(id: string, workItem: WorkItemRecord): Promise<void> {
    const leafState = this.leafState(workItem.state);

    if (leafState === "planned" || leafState === "drafting") {
      await this.commandBus.execute(new PreparePlanCommand(id));
      return;
    }

    if (leafState === "ready") {
      await this.commandBus.execute(new ReopenPlanCommand(id));
      return;
    }

    if (leafState === "in_progress") {
      await this.commandBus.execute(new TransitionInProgressToDraftingCommand(id));
      return;
    }

    throw new BadRequestException(
      `No workflow owns ${workItem.state} -> user.start_draft for ${id}`,
    );
  }

  private async routeInvestigate(id: string, workItem: WorkItemRecord): Promise<void> {
    const leafState = this.leafState(workItem.state);

    if (leafState === "in_progress") {
      await this.commandBus.execute(new TransitionInProgressToReadyCommand(id));
      return;
    }

    const result = await this.hsmService.dispatch(id, { type: "user.investigate" });
    if (result.rejected) {
      throw new BadRequestException(
        `HSM rejected user.investigate from state ${result.prev_state}`,
      );
    }
  }

  private leafState(state: string): string {
    return state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
  }
}
```

Note the constructor no longer uses `@Inject(forwardRef(...))`.
`CommandBus` is injected directly (it's a provider of the global
`PlatformModule`).

### 6. Rewrite `ExecutionController` routes to dispatch commands

This is a consistency pass — the routes in `ExecutionController` that
call `ExecutionService.cancelWorkItem` / `deleteWorkItem` /
`transitionInProgressToX` are rewritten to dispatch the same commands.
This is not strictly necessary (the controller already lives in
`ExecutionModule` next to `ExecutionService`, so a direct call works),
but it locks in the pattern and makes the two HTTP surfaces
(`/api/work-items` + `/api/execution`) consistent.

```typescript
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Sse,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Observable } from "rxjs";
import { ExecutionService } from "./execution.service.js";
import { CancelWorkItemCommand } from "./application/commands/cancel-work-item.command.js";
import { DeleteWorkItemCommand } from "./application/commands/delete-work-item.command.js";
import { TransitionInProgressToDraftingCommand } from "./application/commands/transition-in-progress-to-drafting.command.js";
import { TransitionInProgressToReadyCommand } from "./application/commands/transition-in-progress-to-ready.command.js";
// ... other imports unchanged ...

@Controller("api/execution")
export class ExecutionController {
  constructor(
    @Inject(ExecutionService) private readonly executionService: ExecutionService,
    private readonly commandBus: CommandBus,
  ) {}

  // ... unchanged preview/runs/launch/pull-request/post-merge-sync/cleanup/etc. routes ...

  @Post("transition-ready")
  transitionInProgressToReady(@Body() body: TransitionWorkItemDto) {
    return this.commandBus.execute(
      new TransitionInProgressToReadyCommand(body.work_item_id),
    );
  }

  @Post("transition-drafting")
  transitionInProgressToDrafting(@Body() body: TransitionWorkItemDto) {
    return this.commandBus.execute(
      new TransitionInProgressToDraftingCommand(body.work_item_id),
    );
  }

  @Post("cancel-work-item")
  cancelWorkItem(@Body() body: CancelWorkItemDto): Promise<CancelWorkItemResult> {
    return this.commandBus.execute<CancelWorkItemCommand, CancelWorkItemResult>(
      new CancelWorkItemCommand(body),
    );
  }

  @Post("delete-work-item")
  deleteWorkItem(@Body() body: DeleteWorkItemDto): Promise<DeleteWorkItemResult> {
    return this.commandBus.execute<DeleteWorkItemCommand, DeleteWorkItemResult>(
      new DeleteWorkItemCommand(body),
    );
  }

  // ... unchanged close-merged / archive-and-close-merged / follow-up / etc. routes ...
}
```

The other `ExecutionController` routes (`getPreview`, `listRecentRuns`,
`launch`, `createPullRequest`, etc.) are left untouched for Phase 2.
They are migrated to the command bus progressively in later phases
(`closeMergedPullRequest` / `archiveAndCloseMergedPullRequest` in
Phase 3; `launch` / `createPullRequest` in Phase 4; etc.).

### 7. Remove `forwardRef(() => PlansModule)` from `GraphModule`

```diff
 import { forwardRef, Module } from "@nestjs/common";
 import { ExecutionModule } from "../execution/execution.module.js";
 import { GitHubModule } from "../github/github.module.js";
-import { PlansModule } from "../plans/plans.module.js";
 import { EdgesController } from "./edges.controller.js";
 // ... other imports ...

 @Module({
-  imports: [forwardRef(() => ExecutionModule), forwardRef(() => GitHubModule), forwardRef(() => PlansModule)],
+  imports: [forwardRef(() => ExecutionModule), forwardRef(() => GitHubModule)],
   controllers: [WorkItemsController, EdgesController, GraphController],
   // ... providers/exports unchanged ...
 })
 export class GraphModule {}
```

### 8. Rewrite `work-item-transitions.test.ts`

The existing test at
[`src/modules/graph/__tests__/work-item-transitions.test.ts`](../../src/modules/graph/__tests__/work-item-transitions.test.ts)
constructs `WorkItemsController` with direct `ExecutionService` +
`PlansService` fakes. Rewrite to use a fake `CommandBus` that records
dispatched commands and routes them through an inline map.

```typescript
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ICommand } from "@nestjs/cqrs";
import { WorkItemsController } from "../work-items.controller.js";
import type { WorkItemsService } from "../work-items.service.js";
import type { WorkItemHsmService } from "../work-item-hsm.service.js";
import { CancelWorkItemCommand } from "../../execution/application/commands/cancel-work-item.command.js";
import { TransitionInProgressToDraftingCommand } from "../../execution/application/commands/transition-in-progress-to-drafting.command.js";
import { TransitionInProgressToReadyCommand } from "../../execution/application/commands/transition-in-progress-to-ready.command.js";
import { PreparePlanCommand } from "../../plans/application/commands/prepare-plan.command.js";
import { ReopenPlanCommand } from "../../plans/application/commands/reopen-plan.command.js";
// ... makeWorkItem / makeDispatchResult helpers unchanged from current file ...

interface DispatchedCommand {
  type: string;
  command: ICommand;
}

function makeCommandBus(handlers: Map<Function, (cmd: any) => any>) {
  const dispatched: DispatchedCommand[] = [];
  return {
    dispatched,
    execute: vi.fn(async (command: ICommand) => {
      dispatched.push({ type: command.constructor.name, command });
      const handler = handlers.get(command.constructor);
      if (!handler) {
        throw new Error(`No handler for ${command.constructor.name}`);
      }
      return handler(command);
    }),
  } as any;
}

function makeController(options: {
  initialState?: WorkItemState;
  enabledEvents?: string[];
} = {}) {
  let current = makeWorkItem({ state: options.initialState ?? "planned" });

  const workItemsService = {
    get: vi.fn(() => current),
    update: vi.fn(),
    delete: vi.fn((id: string) => ({ deleted: true as const, id })),
  } as unknown as WorkItemsService;

  const hsmService = {
    getEnabledEvents: vi.fn(() => options.enabledEvents ?? []),
    dispatch: vi.fn(async (_id: string, _event) => ({
      rejected: false,
      prev_state: current.state,
      next_state: current.state,
    })),
  } as unknown as WorkItemHsmService;

  const handlerMap = new Map<Function, (cmd: any) => any>([
    [CancelWorkItemCommand, (cmd: CancelWorkItemCommand) => {
      if (cmd.dto.confirm_cancel !== true) {
        throw new BadRequestException("confirm_cancel must be true");
      }
      current = { ...current, state: "cancelled" };
      return {
        cancelled: true as const,
        work_item: { id: current.id, state: "cancelled", archive_path: null, updated_at: "" },
        closed_issue: {
          repo: current.repo ?? "",
          number: current.issue_number ?? 0,
          url: current.issue_url ?? "",
          title: current.name,
          state: "CLOSED",
        },
        warnings: [],
      };
    }],
    [TransitionInProgressToDraftingCommand, async (_cmd) => {
      current = { ...current, state: "pre_pr.drafting" };
      return current;
    }],
    [TransitionInProgressToReadyCommand, async (_cmd) => {
      current = { ...current, state: "pre_pr.ready" };
      return current;
    }],
    [PreparePlanCommand, async (_cmd) => {
      current = { ...current, state: "pre_pr.drafting" };
      return { work_item_id: current.id, metadata: { state: "drafting" }, scratchpad_content: "# plan" };
    }],
    [ReopenPlanCommand, async (_cmd) => {
      current = { ...current, state: "pre_pr.drafting" };
      return { work_item_id: current.id, metadata: { state: "drafting" }, scratchpad_content: "# plan" };
    }],
  ]);

  const commandBus = makeCommandBus(handlerMap);
  const controller = new WorkItemsController(workItemsService, hsmService, commandBus);

  return { controller, workItemsService, hsmService, commandBus, getCurrent: () => current };
}

// ... then the existing it() cases are rewritten to assert on
//     commandBus.dispatched.map((d) => d.type) rather than on direct
//     service method calls ...
```

The test cases themselves are unchanged in intent — every scenario that
previously verified "`executionService.cancelWorkItem` was called with
X" now verifies "`commandBus.execute` was called with
`CancelWorkItemCommand` containing X". The wiring asserted by the tests
shifts, but the behavioral coverage is the same.

### 9. Handler unit tests

For each new handler file, add a minimal unit test that verifies the
handler delegates to the wrapped service method. These are thin tests
because the handlers themselves are thin. Example:

```typescript
// src/modules/execution/application/commands/__tests__/cancel-work-item.handler.test.ts
import { describe, expect, it, vi } from "vitest";
import { CancelWorkItemHandler } from "../cancel-work-item.handler.js";
import { CancelWorkItemCommand } from "../cancel-work-item.command.js";

describe("CancelWorkItemHandler", () => {
  it("delegates to ExecutionService.cancelWorkItem with the dto", async () => {
    const cancelWorkItem = vi.fn().mockResolvedValue({ cancelled: true });
    const execution = { cancelWorkItem } as any;
    const handler = new CancelWorkItemHandler(execution);

    const result = await handler.execute(
      new CancelWorkItemCommand({
        work_item_id: "studio-42",
        confirm_cancel: true,
        cancel_note: "test",
      }),
    );

    expect(cancelWorkItem).toHaveBeenCalledWith({
      work_item_id: "studio-42",
      confirm_cancel: true,
      cancel_note: "test",
    });
    expect(result).toEqual({ cancelled: true });
  });
});
```

Six handler tests total (one per command). Each is ~20 lines. These
primarily guard against mis-wired handlers: if someone renames
`ExecutionService.cancelWorkItem` without updating the handler,
these tests fail loudly.

### 10. Delete `bus.smoke.test.ts`

The Phase 0 smoke test at
`src/platform/__tests__/bus.smoke.test.ts` was always intended as
temporary infrastructure validation. With Phase 2's real handlers
running through the bus and covered by tests, the smoke test is
redundant and can be deleted.

## Module wiring details

### forwardRef inventory before and after

**Before Phase 2:** 11 forwardRefs (see Phase 1 doc for the breakdown).

**After Phase 2:** 10 forwardRefs. The removed one is
`forwardRef(() => PlansModule)` on `GraphModule.imports`.

```
GraphModule.imports:
  - forwardRef(() => ExecutionModule)    # HsmActionHandlers.runArchiver
  - forwardRef(() => GitHubModule)        # HsmActionHandlers.closeGhIssue
  - forwardRef(() => PlansModule)         # ← REMOVED in Phase 2
ExecutionModule.imports:
  - forwardRef(() => GraphModule)         # ExecutionService needs WorkItems/HSM/Graph
  - forwardRef(() => GitHubModule)        # transitively cyclic via Graph ↔ GitHub
  - forwardRef(() => PlansModule)         # ExecutionService.deleteWorkItem
  - forwardRef(() => SettingsModule)      # transitively cyclic via Graph ↔ Execution
PlansModule.imports:
  - forwardRef(() => GraphModule)         # PlansService needs WorkItems/HSM
  - forwardRef(() => GitHubModule)        # PlansService needs StudioIssueTemplateService
  - forwardRef(() => SettingsModule)      # PlanDrafter uses SettingsService (transitive)
SettingsModule.imports:
  - forwardRef(() => GraphModule)         # defensive; see README
```

Total after Phase 2: **10**.

### Why only −1 and not more?

The `Graph ↔ Plans` cycle is broken by Phase 2 (Graph no longer imports
Plans). That *opens the door* for additional cleanup — specifically,
`PlansModule → GraphModule` and `PlansModule → GitHubModule` could
become direct imports because the cycle on the Plans side is now
one-way. However, doing that cleanup in Phase 2 would bloat the PR and
has no functional value. It is explicitly deferred to Phase 9.

### Why `WorkItemsController` doesn't inject `CommandBus` via `@Inject()`

`CommandBus` is provided by `@nestjs/cqrs` as a standard Nest provider.
Nest's DI resolves it automatically by type — no
`@Inject(CommandBus)` decorator needed. Phase 1's `HsmActionHandlers`
uses `@Inject()` for everything because it's mixed with cross-module
`forwardRef` injections; `WorkItemsController` after Phase 2 only
injects services from its own module + `CommandBus`, so the standard
type-based injection is cleaner.

### Command-result typing

`@nestjs/cqrs` in versions 10 and 11 uses
`ICommandHandler<TCommand, TResult>` with TypeScript inference when the
handler is declared. The caller pattern
`commandBus.execute<TCommand, TResult>(new Command(...))` makes the
return type explicit. If you upgrade to `@nestjs/cqrs@12`, the
`Command<TResult>` base class gives first-class typed return values and
the generic on `execute` becomes redundant — migrating that is a
one-line change per call site.

## Tests

### Unit tests

- Six new handler tests (one per command) at
  `src/modules/execution/application/commands/__tests__/*.handler.test.ts`
  and `src/modules/plans/application/commands/__tests__/*.handler.test.ts`
- Rewritten `src/modules/graph/__tests__/work-item-transitions.test.ts`
  using the fake-command-bus pattern shown in §8

### Integration tests

- Run the full `vitest` suite. Every pre-existing test should pass
  without behavior changes.
- In particular, `src/modules/execution/__tests__/disposition.test.ts`
  tests `closeMergedPullRequest` / `archiveAndCloseMergedPullRequest` —
  those call paths are untouched by Phase 2 (Phase 3 handles them).

### Manual smoke tests

1. Start the dev server: `npm run dev`
2. Click "Prepare plan" on a `planned` work item in the Sidebar.
   Verify the plan transitions to `drafting` and the scratchpad appears.
3. Click "Approve plan". Verify the plan transitions to `ready`.
4. Click "Cancel work item" on an issue-backed node. Verify the dialog
   opens, the checkbox gate works, and on confirmation the work item
   transitions to `cancelled` and the GitHub issue is closed.
5. Via `curl`, call `POST /api/execution/delete-work-item` with
   `{ "work_item_id": "studio-XXX", "confirm_delete": true, "allow_graph_delete_without_github": true }`.
   Verify the work item and its GitHub issue are removed (or the
   fallback path runs if gh delete fails).

## Acceptance criteria

- [ ] Six new `.command.ts` + `.handler.ts` file pairs exist under
      `src/modules/execution/application/commands/` and
      `src/modules/plans/application/commands/`
- [ ] Each handler is registered as a provider in its module's
      `@Module({ providers: [...] })` array
- [ ] `WorkItemsController` constructor no longer injects `ExecutionService`
      or `PlansService`. `grep 'forwardRef' src/modules/graph/work-items.controller.ts`
      returns zero hits
- [ ] `ExecutionController` constructor still injects `ExecutionService`
      (for the read-side and launch routes not migrated in this phase)
      but the cancel / delete / transition / close / archive routes
      now dispatch `CommandBus.execute(...)`
- [ ] `src/modules/graph/graph.module.ts` no longer imports `PlansModule`
- [ ] `grep -o 'forwardRef(' src/modules/*/*.module.ts | wc -l` returns
      **10** (was 11)
- [ ] `src/modules/graph/__tests__/work-item-transitions.test.ts` is
      rewritten and passes
- [ ] Six new handler unit tests pass
- [ ] `src/platform/__tests__/bus.smoke.test.ts` is deleted
- [ ] `npm run check` (tsc) is clean
- [ ] `npm test` passes (every existing test plus the new ones)
- [ ] `npm run build:web` is clean
- [ ] Manual smoke tests §§1–5 all pass
- [ ] PR description documents the forwardRef count change (11 → 10)
      and links this proposal doc

## Known remaining drift

After Phase 2:

- **`GraphModule → ExecutionModule` forwardRef is still in place.**
  `HsmActionHandlers.runArchiver` still calls
  `ExecutionService.runArchiverAction` (per Phase 1). Phase 3 breaks
  this by extracting the archival logic out of `ExecutionService` and
  using a command bus dispatch from `HsmActionHandlers.runArchiver`.

- **`ExecutionModule → PlansModule` forwardRef is still in place.**
  `ExecutionService.deleteWorkItem` calls
  `this.plansService.deletePlanArtifacts(workItemId)` directly. That
  could be migrated to a `DeletePlanArtifactsCommand` dispatched
  through the bus, eliminating the injection. Phase 3 will fold this
  into the extraction work.

- **Cosmetic forwardRef cleanup on PlansModule is deferred to Phase 9.**
  `PlansModule → GraphModule`, `PlansModule → GitHubModule`, and
  `PlansModule → SettingsModule` could all become direct imports now
  that `Graph → Plans` is gone, but the cleanup has no functional
  value and would bloat the Phase 2 PR.

- **No god-class shrinkage.** `ExecutionService` still has 3,286 lines
  after Phase 2. The handler files wrap existing methods without moving
  any logic. Phase 3 and Phase 4 do the actual extraction.

- **The `ExecutionController` still injects `ExecutionService` directly**
  for the read routes (`getPreview`, `listRecentRuns`, `launch`,
  `createPullRequest`, `syncMergedPullRequest`, `cleanupWorktree`,
  `sendFollowUp`, `resolveDisambiguation`, `getRunActivityLog`,
  `getRunChatHistory`, `getRunChecklist`, `getRunScratchpad`, `stream`,
  `getArchivedRunBundle`, `listArchivedRunBundles`, `getLaunchEligibility`).
  These are migrated progressively in Phases 3 and 4. There is no
  architectural harm in leaving them for now — the controller lives in
  the same module as the service, so the direct injection doesn't
  introduce cross-module coupling.

## Next steps

[Phase 3](phase-3-execution-subservices.md) extracts sub-services from
`ExecutionService` and finally breaks the `Graph ↔ Execution` cycle.
The key move: `HsmActionHandlers.runArchiver` dispatches an
`ArchiveRunArtifactsCommand` through the command bus instead of calling
`ExecutionService.runArchiverAction` directly. That removes
`GraphModule → ExecutionModule`'s forwardRef and cuts the run-disposal
logic out of `ExecutionService` into a narrow `RunDispositionService`.
