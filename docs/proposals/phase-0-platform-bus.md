# Phase 0 — Platform bus via `@nestjs/cqrs`

**Status:** proposed
**Owner:** unassigned
**Predecessors:** none
**Successors:** [phase-1-hsm-action-handlers.md](phase-1-hsm-action-handlers.md)
**Estimated effort:** half a day

## Motivation

The backend has **eleven** `forwardRef(() => OtherModule)` calls at the
module level, participating in four real circular dependency groups (see
`docs/diagrams/components/02-backend-modules.puml` and verify with
`grep -o 'forwardRef(' src/modules/*/*.module.ts | wc -l`). The real
cycles are `Graph ↔ Execution`, `Graph ↔ GitHub`, `Graph ↔ Plans`, and
`Execution ↔ Plans`; the remaining `forwardRef()` calls are defensive
wrapping of one-way imports that transit through those cycles. Every
cycle exists because two feature modules need to inject each other's
services directly. Every new cross-cutting feature adds another cycle
or forces an existing service to grow to accommodate the call it can't
route through a clean interface.

The root issue isn't NestJS — it's that we're using direct service imports
as the primary mechanism for cross-module communication. Nest gives us DI,
decorators, lifecycle hooks, and `Test.createTestingModule` ergonomics that
we want to keep. What we want to change is the social rule:

> **Feature modules communicate with each other through commands and events,
> not through direct service imports.**

This phase installs the infrastructure that makes that rule enforceable. It
does not migrate any existing code onto the bus — that's Phase 1 and later.
Phase 0 is strictly plumbing.

## Decision: use `@nestjs/cqrs`

Instead of rolling a custom command bus + event bus, we install
`@nestjs/cqrs` — the Nest team's official CQRS implementation. It provides:

- `CommandBus` with `execute<TCommand, TResult>(command)` — one handler per
  command class, typed return value, async
- `EventBus` with `publish(event)` / `publishAll(events)` — many subscribers
  per event, fire-and-forget
- `QueryBus` — not used by this codebase yet, available for read models later
- Auto-registration: Nest scans providers on `onApplicationBootstrap` for
  `@CommandHandler(CommandClass)` + `@EventsHandler(EventClass)` decorators
  and wires them to their class discriminators
- Saga support for multi-step event-driven workflows (useful for later phases
  that coordinate across bounded contexts)

Rolling our own bus would cost ~80 lines of code plus tests plus ongoing
maintenance, with no upside over the Nest-official package. `@nestjs/cqrs`
is ~50 kB, maintained by the Nest core team, and compatible with our
`@nestjs/common@^11.1.6`.

**Decision: buy, don't build.**

## Scope

**In:**

- Install `@nestjs/cqrs@^11`
- Create `src/platform/platform.module.ts` as a `@Global()` Nest module that
  re-exports `CqrsModule`
- Wire `PlatformModule` into `AppModule.imports`
- Add a smoke test that proves a command can round-trip and publish an event
  that an event handler observes
- Document the conventions for writing commands, events, and handlers in
  this proposal doc (not elsewhere — the conventions go in
  `docs/diagrams/ARCHITECTURE.md` as part of Phase 1 or later)

**Out:**

- No existing code is migrated onto the bus
- No existing `forwardRef` is removed
- No service is extracted, renamed, or deleted
- No changes to the HSM, plans, runs, GitHub, or frontend
- No production handlers are registered yet — the smoke test uses a
  throwaway `PingCommand` / `PongEvent` pair that gets deleted in Phase 1
  or Phase 2 when the first real handler lands

Phase 0 is deliberately small enough to merge on day 1. Every subsequent
phase depends on the infrastructure landing clean and tested.

## File changes

### 1. Install the dependency

```bash
npm install @nestjs/cqrs@^11
```

`@nestjs/cqrs@^11` tracks `@nestjs/common@11.x`, which this repo already
depends on. Commit `package.json` + `package-lock.json` in the same PR.

Verify:

```bash
npm ls @nestjs/cqrs
```

should show a single `@nestjs/cqrs@11.x` entry with no peer-dependency
warnings.

### 2. Create `src/platform/platform.module.ts`

New file. ~20 lines.

```typescript
import { Global, Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

/**
 * Global platform infrastructure. Every feature module gets access to
 * CommandBus, EventBus, and QueryBus (from @nestjs/cqrs) without having
 * to import PlatformModule explicitly — the @Global() decorator makes
 * its exports available to every module.
 *
 * Feature modules MUST NOT import other feature modules directly.
 * Cross-context communication routes through:
 *
 *   - CommandBus.execute(new OtherContextCommand(...))  — when one caller
 *     expects one handler to run and return a result
 *   - EventBus.publish(new SomethingHappenedEvent(...))  — when N
 *     subscribers react to a domain fact, fire-and-forget
 *
 * See docs/proposals/phase-0-platform-bus.md for the conventions the bus
 * imposes and the rationale for the module star-shape.
 */
@Global()
@Module({
  imports: [CqrsModule],
  exports: [CqrsModule],
})
export class PlatformModule {}
```

### 3. Update `src/app.module.ts`

Add `PlatformModule` to the imports list. Because it's `@Global()`, no
other module needs to import it.

```diff
 import { Module } from "@nestjs/common";
 import { ScheduleModule } from "@nestjs/schedule";
+import { PlatformModule } from "./platform/platform.module.js";
 import { ExecutionModule } from "./modules/execution/execution.module.js";
 import { GitHubModule } from "./modules/github/github.module.js";
 import { GraphModule } from "./modules/graph/graph.module.js";
 import { HealthModule } from "./modules/health/health.module.js";
 import { PlanningModule } from "./modules/planning/planning.module.js";
 import { PlansModule } from "./modules/plans/plans.module.js";
 import { ReconciliationModule } from "./modules/reconciliation/reconciliation.module.js";
 import { SettingsModule } from "./modules/settings/settings.module.js";

 @Module({
-  imports: [ScheduleModule.forRoot(), ExecutionModule, GraphModule, HealthModule, GitHubModule, PlanningModule, PlansModule, ReconciliationModule, SettingsModule],
+  imports: [
+    PlatformModule,
+    ScheduleModule.forRoot(),
+    ExecutionModule,
+    GraphModule,
+    HealthModule,
+    GitHubModule,
+    PlanningModule,
+    PlansModule,
+    ReconciliationModule,
+    SettingsModule,
+  ],
 })
 export class AppModule {}
```

(The imports are also reformatted to one-per-line for future diff
friendliness. Cosmetic but worth doing while the file is open.)

### 4. Create `src/platform/__tests__/bus.smoke.test.ts`

New file. Proves the bus works end-to-end before any real handler is
migrated onto it. Gets deleted once Phase 1 or Phase 2 introduces a
production handler — this is strictly throwaway infrastructure validation.

```typescript
import { Injectable } from "@nestjs/common";
import {
  CommandBus,
  CommandHandler,
  EventBus,
  EventsHandler,
  ICommand,
  ICommandHandler,
  IEvent,
  IEventHandler,
} from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { PlatformModule } from "../platform.module.js";

class PingCommand implements ICommand {
  constructor(public readonly message: string) {}
}

class PongEvent implements IEvent {
  constructor(public readonly echo: string) {}
}

@CommandHandler(PingCommand)
@Injectable()
class PingHandler implements ICommandHandler<PingCommand, string> {
  constructor(private readonly eventBus: EventBus) {}

  async execute(command: PingCommand): Promise<string> {
    const response = `pong:${command.message}`;
    this.eventBus.publish(new PongEvent(response));
    return response;
  }
}

@EventsHandler(PongEvent)
@Injectable()
class PongRecorder implements IEventHandler<PongEvent> {
  readonly received: string[] = [];

  handle(event: PongEvent): void {
    this.received.push(event.echo);
  }
}

describe("platform bus smoke test", () => {
  let commandBus: CommandBus;
  let recorder: PongRecorder;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PlatformModule],
      providers: [PingHandler, PongRecorder],
    }).compile();

    // CqrsModule registers decorated handlers during app bootstrap.
    // Test.createTestingModule does not call onApplicationBootstrap
    // automatically — init() triggers it.
    await moduleRef.init();

    commandBus = moduleRef.get(CommandBus);
    recorder = moduleRef.get(PongRecorder);
  });

  it("routes a command through its handler and returns the result", async () => {
    const result = await commandBus.execute<PingCommand, string>(
      new PingCommand("hello"),
    );
    expect(result).toBe("pong:hello");
  });

  it("publishes an event from inside a handler and routes it to subscribers", async () => {
    await commandBus.execute<PingCommand, string>(new PingCommand("world"));
    // Event handlers are invoked synchronously when the event is published
    // in the same tick. If this test becomes flaky after upgrading
    // @nestjs/cqrs, wrap in a short `await new Promise(r => setImmediate(r))`.
    expect(recorder.received).toEqual(["pong:world"]);
  });

  it("returns undefined when a command has no registered handler", async () => {
    class UnregisteredCommand implements ICommand {}
    await expect(
      commandBus.execute(new UnregisteredCommand()),
    ).rejects.toThrow(); // @nestjs/cqrs throws `CommandHandlerNotFoundException`
  });
});
```

The test file lives at `src/platform/__tests__/bus.smoke.test.ts` to match
the existing convention (`src/**/__tests__/**/*.test.ts`) picked up by
`vitest.config.ts`.

## Conventions

Established here, referenced by every subsequent phase. Copy relevant
sections into `docs/diagrams/ARCHITECTURE.md` as part of Phase 1 when the
first real handler lands.

### Command conventions

- **One handler per command.** `@nestjs/cqrs` throws
  `CommandHandlerNotFoundException` at dispatch time if no handler exists,
  and throws at bootstrap if two handlers are registered for the same
  command class.
- **Commands describe intent, not implementation.** `LaunchRunCommand`, not
  `CallExecutionServiceLaunch`. A command name survives the refactor that
  moves its handler; a method name doesn't.
- **Commands may return a result** via
  `ICommandHandler<TCommand, TResult>`. Use this for synchronous
  request/response flows where an HTTP handler needs a payload back.
- **Commands are immutable value objects.** Public `readonly` fields only,
  no methods, no setters, no mutable state.
- **Commands live next to their handler** in
  `application/commands/<command-name>.{command,handler}.ts` under the
  owning bounded context.

Example:

```typescript
// src/work-items/application/commands/cancel-work-item.command.ts
import { ICommand } from "@nestjs/cqrs";

export class CancelWorkItemCommand implements ICommand {
  constructor(
    public readonly workItemId: string,
    public readonly confirmCancel: boolean,
    public readonly cancelNote?: string,
  ) {}
}
```

```typescript
// src/work-items/application/commands/cancel-work-item.handler.ts
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { CancelWorkItemCommand } from "./cancel-work-item.command.js";
import type { CancelWorkItemResult } from "../types.js";

@CommandHandler(CancelWorkItemCommand)
export class CancelWorkItemHandler
  implements ICommandHandler<CancelWorkItemCommand, CancelWorkItemResult>
{
  async execute(command: CancelWorkItemCommand): Promise<CancelWorkItemResult> {
    // ... logic
  }
}
```

### Event conventions

- **Many subscribers per event.** Events describe "something happened," not
  "please do something." Fire-and-forget, one-way, no return value.
- **Event names are past tense.** `WorkItemFinalizedEvent`,
  `RunCompletedEvent`, `PullRequestMergedEvent`. Never `FinalizeWorkItem`
  (that's a command) or `WorkItemFinalize` (present-tense is a smell).
- **Event handlers must not throw in normal operation.** `@nestjs/cqrs`
  propagates handler exceptions to the publisher by default in some
  versions; at minimum, a throwing handler can block later subscribers for
  the same event. Use try/catch inside the handler and publish a
  compensating event if you need to signal failure.
- **Events are immutable.** Same rules as commands.
- **Events live with their aggregate** in `domain/events.ts` under the
  owning bounded context. Handlers may live in a different context —
  that's the whole point.

Example:

```typescript
// src/work-items/domain/events.ts
import { IEvent } from "@nestjs/cqrs";

export class WorkItemFinalizedEvent implements IEvent {
  constructor(
    public readonly workItemId: string,
    public readonly finalState: "done" | "archived",
    public readonly closedIssueNumber: number | null,
  ) {}
}
```

```typescript
// src/runs/application/handlers/on-work-item-finalized.handler.ts
import { EventsHandler, IEventHandler } from "@nestjs/cqrs";
import { WorkItemFinalizedEvent } from "../../../work-items/domain/events.js";

@EventsHandler(WorkItemFinalizedEvent)
export class OnWorkItemFinalizedHandler
  implements IEventHandler<WorkItemFinalizedEvent>
{
  handle(event: WorkItemFinalizedEvent): void {
    // dispose matching runs, stamp disposed_at, etc.
  }
}
```

### Module rules

- Feature modules import **only** `PlatformModule` (implicitly via
  `@Global`) and their own sub-modules.
- Feature modules **do not** import other feature modules — not even via
  `forwardRef`.
- Cross-context calls use
  `CommandBus.execute(new OtherContextCommand(...))` or publish events
  that other contexts subscribe to.
- Command + event handlers are registered as regular Nest providers in
  the `providers` array of their owning module. `@nestjs/cqrs` scans them
  on `onApplicationBootstrap`.
- Exception: Nest's own infrastructure modules like `ScheduleModule` may
  be imported at `AppModule` level. The rule applies only to feature
  modules (`WorkItemsModule`, `RunsModule`, `PlansModule`, etc.).

## Acceptance criteria

A Phase 0 PR is ready to merge when:

- [ ] `npm install @nestjs/cqrs@^11` has been run; `package.json` and
      `package-lock.json` are updated and committed in this PR
- [ ] `npm ls @nestjs/cqrs` reports a single installed version with no
      peer-dependency warnings
- [ ] `src/platform/platform.module.ts` exists, is `@Global()`, imports
      and exports `CqrsModule`, has the docstring above
- [ ] `src/app.module.ts` imports `PlatformModule` as its first feature
      import
- [ ] `src/platform/__tests__/bus.smoke.test.ts` exists with the three
      tests above (or equivalents) and passes under `npm test`
- [ ] `npm run check` (tsc) is clean
- [ ] `npm test` passes — every pre-existing test still green, plus the
      new smoke test
- [ ] `npm run build:web` is clean
- [ ] `grep -o 'forwardRef(' src/modules/*/*.module.ts | wc -l`
      returns the same number it returned before this PR — **expected:
      11** (Phase 0 does not remove any forwardRefs; that's Phase 2+ work
      since Phase 1 is also a no-op on the count)
- [ ] The dev server boots (`npm run dev`) and `GET /health` returns
      `{ok: true, ...}` — no regression in the existing HTTP surface
- [ ] The PR description documents: (a) the current `forwardRef` count
      (target: same as before), (b) a link to this proposal doc, and
      (c) what the next phase will do

## What's NOT in Phase 0

Restating for clarity:

- **No existing code is migrated onto the bus.** No controller is rewritten,
  no service is split, no handler replaces an inline call.
- **No `forwardRef` is removed.** The module graph is unchanged.
- **No HSM work.** `HsmActionHandlers` is untouched.
- **No frontend changes.** `web/` is untouched.
- **No API surface changes.** Every HTTP endpoint behaves identically.
- **No test deletions.** The smoke test is additive.
- **No conventions file.** Conventions are documented in this proposal
  only; they move to `docs/diagrams/ARCHITECTURE.md` when Phase 1 (the
  first phase that actually uses them) lands.

## Next steps

[Phase 1](phase-1-hsm-action-handlers.md) is the first real use of the bus
— no, not quite. Phase 1 is actually independent of the bus: it
wires up `HsmActionHandlers` as the real registration path for the
`closeGhIssue` and `runArchiver` SCXML actions. It does not use the
command bus (HSM action handlers have their own registration mechanism).

Phase 2 will be the first phase that actually dispatches commands through
the Phase 0 bus — specifically, it moves `cancelWorkItem` and
`deleteWorkItem` out of `ExecutionService` into command handlers, letting
`WorkItemsController` dispatch `CancelWorkItemCommand` / `DeleteWorkItemCommand`
instead of calling `ExecutionService` directly (which removes the
`GraphModule → ExecutionModule` forwardRef).

So Phase 0 is needed before Phase 2, even though Phase 1 doesn't use it.
Phase 1 is orthogonal infrastructure cleanup that happens to be easy to
land next because it has no dependencies.
