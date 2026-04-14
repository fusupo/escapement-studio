# Escapement Studio — Architecture Assessment

**Date:** 2026-04-12
**Scope:** the NestJS backend at `src/modules/**`, plus the module wiring
in `src/app.module.ts`. Frontend is out of scope except where a backend
change forces a frontend follow-up.

This document is the grounded reference for the in-progress refactor.
It exists because the earlier phase docs (phase-0, phase-1, phase-2)
were drafted from memory after a context compaction and drifted away
from the actual code. Everything here was re-verified against the
working tree on 2026-04-12.

Read this before writing any new phase doc.

---

## 1. The decision: migrate, don't rebuild

Three frames collided when this refactor was scoped:

1. **Rebuild from scratch.** Draw a clean context map, pick fresh
   boundaries, freeze features until the new thing can do what the old
   one does.
2. **Migrate in place, incrementally.** Keep every phase mergeable, keep
   the app running, trend the bad metrics down without a freeze.
3. **Just live with it.** The system works; bolt on fixes as needed.

Rebuild has the tightest resulting architecture on paper but loses the
edge-case knowledge accumulated over months — the comments in
`executeRun` that say "ADR 014 step 5", the
`assertNoActiveRunForWorkItem` guard that explains the restart gap, the
`syncScratchpadToCanonical` phase-boundary dance, the
`autoStageAndCommit` guard against `SCRATCHPAD_*.md`. A rebuild re-
discovers all of that the hard way, usually at 11pm on a Friday.

"Just live with it" loses because specific forcing functions are now
biting: the 3286-line `ExecutionService` is a merge-conflict hot zone,
the shadow `HsmActionHandlers` / `HsmGuardHandlers` classes mislead new
readers into thinking they're live, and the 11 module-level
`forwardRef` wrappers produce baffling Nest container errors the first
time someone unwraps one that turns out to be load-bearing.

Migration wins because **NestJS stays**. The decorators
(`@Controller`, `@Cron`, `@Sse`, `@Injectable`, `@Module`) and the DI
container are not the problem — the problem is what was put in which
module and how those modules reach for each other. Nest is compatible
with every target architecture on the table (hexagonal, ports/adapters,
DDD bounded contexts, CQRS). The social rule about cross-module imports
is the only thing that changes.

Every migration phase must satisfy:

1. Independently valuable — if work stops after this phase, the
   codebase is strictly better.
2. Revertable as a single PR — no half-landed states, no feature flags.
3. No feature freeze — the app keeps serving HTTP the whole time.
4. Tests stay green; new tests cover new seams.

These are the operating principles. A refactor that doesn't hit all
four is a rewrite dressed up as a refactor.

---

## 2. Current module map

The backend has nine Nest modules plus one platform dependency
(`ScheduleModule` from `@nestjs/schedule`). The module-level import
graph, with forwardRefs marked:

```
AppModule
├── ScheduleModule.forRoot()  (external)
├── GraphModule
│     ├── forwardRef(ExecutionModule)
│     ├── forwardRef(GitHubModule)
│     └── forwardRef(PlansModule)
├── ExecutionModule
│     ├── forwardRef(GraphModule)
│     ├── forwardRef(GitHubModule)
│     ├── forwardRef(PlansModule)
│     └── forwardRef(SettingsModule)
├── GitHubModule
│     └── GraphModule                (direct — no forwardRef)
├── PlansModule
│     ├── forwardRef(GraphModule)
│     ├── forwardRef(GitHubModule)
│     └── forwardRef(SettingsModule)
├── SettingsModule
│     └── forwardRef(GraphModule)
├── PlanningModule
│     ├── GraphModule                (direct)
│     ├── GitHubModule               (direct)
│     ├── ReconciliationModule       (direct)
│     └── SettingsModule             (direct)
├── ReconciliationModule
│     ├── GraphModule                (direct)
│     └── ExecutionModule            (direct)
└── HealthModule                     (no imports)
```

**Not imported anywhere:** `GitModule` (exists under `src/modules/git/`
but nothing in `AppModule` pulls it in). See §8.

### 2.1 The forwardRef tally

```
graph.module.ts       3 — forwardRef(Execution), forwardRef(GitHub), forwardRef(Plans)
execution.module.ts   4 — forwardRef(Graph), forwardRef(GitHub), forwardRef(Plans), forwardRef(Settings)
plans.module.ts       3 — forwardRef(Graph), forwardRef(GitHub), forwardRef(Settings)
settings.module.ts    1 — forwardRef(Graph)
                     ──
                     11 module-level forwardRef wrappers
```

An additional **four** `forwardRef` references live inside `@Inject`
decorators at the provider level:

```
execution/execution.service.ts:100   @Inject(forwardRef(() => PlansService))
graph/work-items.controller.ts:47    @Inject(forwardRef(() => ExecutionService))
graph/work-items.controller.ts:49    @Inject(forwardRef(() => PlansService))
graph/hsm-action-handlers.ts:54      @Inject(forwardRef(() => PlansService))
```

Those are secondary — they exist because the module import is also
forwardRef'd, and Nest requires the same wrapping at the injection
site. Drop the module-level forwardRef and the injection-site one
becomes a no-op (or stops being needed at all if the provider moves to
a module where the dependency is directly available).

### 2.2 Cycles, real vs defensive

A true cycle is one where the dependency graph has a closed loop and
at least one edge *must* be forwardRef'd for Nest's container to
resolve. A defensive forwardRef is one added to break a transitive
cycle that only forms because of how another module is wired — remove
that other wiring and the forwardRef becomes unnecessary.

Tracing the module graph, the direct 2-cycles are:

1. **Graph ↔ Execution** (both forwardRef) — real. Driven by
   `HsmActionHandlers.executionService` (graph/hsm-action-handlers.ts:50),
   `HsmActionHandlers.githubBatchCache` (line 52) which lives in
   ExecutionModule, `HsmGuardHandlers.githubBatchCache` (hsm-guard-
   handlers.ts:8), `WorkItemsController.executionService` (work-items.
   controller.ts:47), and on the other side
   `ExecutionService.workItemsService / graphService / hsmService`
   (execution.service.ts:93–95).

2. **Graph ↔ GitHub** — partial. GitHubModule imports GraphModule
   **directly** (github.module.ts:8) because `GitHubService` injects
   `SQLiteService` (github.service.ts:119) and `WorkItemsService`
   (line 120), both of which live in GraphModule. GraphModule imports
   GitHubModule via forwardRef because `HsmActionHandlers.githubService`
   (hsm-action-handlers.ts:51) calls `githubService.readIssue` and
   `githubService.closeIssue`. The cycle exists even though Graph's
   import is the only explicit `forwardRef` — Nest tolerates it because
   GitHub's `import [GraphModule]` is resolved first in topological
   order.

3. **Graph ↔ Plans** (both forwardRef) — real. Driven by
   `WorkItemsController.plansService` (work-items.controller.ts:49),
   `HsmActionHandlers.plansService` (hsm-action-handlers.ts:54) on the
   Graph side; and `PlansService.workItemsService / hsmService`
   (plans.service.ts:52–53) on the Plans side.

Everything else is defensive. Walk the transitive closures:

- **Execution → Plans (fwd)** defends against
  `Execution → Plans → Graph → Execution`.
  The cycle only exists because Plans imports Graph; break
  Graph ↔ Plans and this forwardRef becomes redundant.
- **Execution → GitHub (fwd)** defends against
  `Execution → GitHub → Graph → Execution`.
  Break Graph ↔ GitHub and this becomes redundant.
- **Execution → Settings (fwd)** defends against
  `Execution → Settings → Graph → Execution`.
  Break Settings → Graph (by moving SQLite out of Graph; see §7) and
  this becomes redundant.
- **Plans → GitHub (fwd)** defends against
  `Plans → GitHub → Graph → Plans`.
- **Plans → Settings (fwd)** defends against
  `Plans → Settings → Graph → Plans`.
- **Settings → Graph (fwd)** is the root of most of the transitive
  noise. SettingsService injects `SQLiteService` (settings.service.ts:
  39) and that's all — a single dependency on one infrastructure class
  that happens to live in GraphModule.

**This means three structural changes would eliminate ~8 of the 11
module-level forwardRefs:**

A. Move `SQLiteService` out of GraphModule into a new infrastructure
   module (call it `PlatformModule` or `InfraModule`). GitHubModule,
   SettingsModule, and anyone else who needs raw SQLite imports that
   module directly. No cycle with anything.

B. Move `HsmActionHandlers` out of GraphModule into whichever module
   needs it (likely ExecutionModule, since most of its handlers call
   `ExecutionService`). GraphModule stops injecting
   `ExecutionService / GithubService / GithubBatchCache / PlansService`
   through HsmActionHandlers.

C. Move `WorkItemsController`'s execution/plans calls onto the command
   bus (this is Phase 2's stated goal). GraphModule stops injecting
   `ExecutionService / PlansService` through the controller.

B + C between them let GraphModule drop all three of its own
forwardRefs, and the transitive defensive wrappers on Execution/Plans/
Settings fall away because the underlying cycles no longer exist. A
plus B plus C takes the count from 11 → ~1 or 0.

The current 9-phase plan implements some of these (Phase 1, Phase 2,
Phase 6), but not in the cleanest order. See §12.

---

## 3. Smell #1: `ExecutionService` is a god class

> The size thresholds discussed below (~400 / ~600 / ~1000 lines) are
> codified as a written convention in
> [`CLAUDE.md`](../../CLAUDE.md#service-size-convention).
> Treat that as the forcing function for future extractions; §3 is
> the historical rationale behind the numbers.

**File:** `src/modules/execution/execution.service.ts`
**Size:** 3286 lines
**Constructor:** 8 injected services, one of them forwardRef'd.

Functional clusters, with approximate line ranges, in the order they
appear:

| Range | Responsibility |
|---:|---|
| 116–199 | `onModuleInit` — orphan detect → rehydrate runs → **inline register HSM action handlers for `closeGhIssue` and `runArchiver`** |
| 225–300 | SSE stream, recent runs accessors, `refreshPullRequestTruth` (callback registered into `GitHubService`) |
| 302–392 | Dispatch preview + launch eligibility (`getPreview`, `getLaunchEligibility`) |
| 394–470 | `launch` — the HTTP-facing launch entry point |
| 472–704 | Pull request flows: `createPullRequest`, `syncMergedPullRequest` |
| 706–790 | Worktree cleanup (`cleanupWorktree`, `cleanupAllStale`, `removeWorktreeAndBranch`) |
| 792–824 | Disambiguation gate resolution |
| 826–1103 | **`executeRun`** — the 280-line coroutine that owns: worktree git setup, npm install, context gathering, canonical scratchpad seeding, pi-coding-agent session creation, setup phase (with user approval gate), coding phase, completion + file sync |
| 1105–1156 | Run accessors (activity log, chat history, checklist, scratchpad) |
| 1158–1181 | Archived run bundle listing |
| 1183–1305 | `sendFollowUp` + `executeFollowUpTurn` — session reuse for post-completion turns |
| 1307–1427 | `handleSessionEvent` — pi-coding-agent event stream → activity log + checklist deltas |
| 1446–1609 | Launch eligibility internals (safety checks, `evaluateSafety`, per-check helpers) |
| 1611–1745 | Prompt builders (`buildSetupPrompt`, `buildDoWorkPrompt`, `buildPrompt`) |
| 1747–1920 | Scratchpad management (`buildScratchpad`, `syncScratchpadToCanonical`, `parseScratchpadOpenItems`, `writeScratchpad`) |
| 1922–2005 | `createHsmRunRecord` + private `createRunRecord` + `persistRun` — the run-store core |
| 2007–2186 | Run persistence primitives: `updateRun`, `upsertRecentRun`, `writeMetadata`, `writeStatus`, `writeSummary`, `appendEvent`, `emitRun` |
| 2187–2268 | Shell wrappers (`runGit`, `runGhIn`, `runCommand`) + PR read-back |
| 2270–2368 | Commit guards + scratchpad violation detection (ADR 014 step 6) |
| 2369–2442 | `syncActualFiles`, launch transition helpers (`markWorkItemInProgressOnLaunch`, `transitionInProgressToReady/Drafting`) |
| 2444–2742 | **Disposition flows**: `closeMergedPullRequest`, `archiveAndCloseMergedPullRequest`, `removeRunsForWorkItem`, `captureRunSnapshotForWorkItem` |
| 2744–2905 | `cancelWorkItem`, `deleteWorkItem`, + their eligibility guards |
| 2907–3080 | More disposition helpers: `assertWorkItemInMergedPr`, `assertNoActiveRunForWorkItem`, `archiveRunArtifacts`, `movePlanDirToArchives` |
| 3082–3270 | Merge sync helpers, normalization, PR record conversion, `now`, `getErrorMessage` |

**Natural extractions** (not all in the current 9-phase plan):

- **`RunStore`** — recentRuns buffer, status.json/metadata.json/
  events.jsonl/summary.md writes, hydration, the 16-entry cap. Lines
  1922–2186 plus scattered calls. Roughly 400 lines.
- **`WorktreeService`** — git worktree add/remove/prune, branch
  cleanup, the safety checks in 1530–1609, the path bounding guard.
  Roughly 200 lines.
- **`ScratchpadService`** — canonical/worktree scratchpad sync,
  checklist parse, commit-guard scratchpad detection, the open-items
  parse. Lines 1747–1920 plus 2270–2368. Roughly 350 lines.
- **`RunInteractionService`** — `handleSessionEvent`, disambiguation
  gate, follow-up turns, the agent session lifecycle wrapping. Lines
  792–824, 1183–1427. Roughly 300 lines.
- **`PullRequestService`** — `createPullRequest`, `syncMergedPullRequest`,
  `refreshPullRequestTruth`, PR body/title builders, the staged-scratchpad
  guard. Lines 472–704 plus helpers. Roughly 400 lines.
- **`RunDispositionService`** — merged-PR close/archive-and-close
  flows, plan dir archival, run removal finalizer, the disposition
  guards, the capture-snapshot helper. Lines 2444–2905 plus 2907–3080.
  Roughly 600 lines.
- **`LaunchEligibilityService`** — dispatch preview + eligibility
  computation. Lines 302–392, 1446–1609. Roughly 250 lines.

**`launch` and `executeRun` are the orchestrators that use all of the
above.** They stay in `ExecutionService` (renamed to
`ExecutionRunnerService` maybe) at roughly 400 lines.

Extracting all of this is Phase 4 in the current plan. The god class
doesn't need to drop to the ideal ~400 lines in one PR — a good Phase
4 extracts 2–3 sub-services and shrinks the class to ~2000 lines, and
the remaining work is follow-up phases.

---

## 4. Smell #2: shadow HSM vocabulary

`WorkItemHsmService` exposes `registerActionHandler(actionName,
handler)` as the seam for external modules to plug in side-effect
handlers that fire during dispatch. The runtime handler type (from
`graph/types.ts:261`) is:

```typescript
interface HsmActionHandler {
  (
    workItem: WorkItemRecord,
    event: WorkItemHsmEvent,
    context: HsmActionHandlerContext,
  ): Promise<void>;
}
```

External modules are supposed to register handlers during
`onModuleInit`. At runtime, **only `ExecutionService.onModuleInit`
registers anything** — at lines 134 and 154:

```typescript
// execution.service.ts:134
this.hsmService.registerActionHandler("closeGhIssue", async (workItem, _event, ctx) => { … });

// execution.service.ts:154
this.hsmService.registerActionHandler("runArchiver", async (workItem, _event, ctx) => { … });
```

These closures capture `this.githubService`, `this.captureRunSnapshotForWorkItem`,
`this.movePlanDirToArchives`, `this.artifactRoot`, `this.now`, and
`this.logger`. They're 65 lines of inline logic that should live in a
named class with its own file.

Meanwhile, `src/modules/graph/hsm-action-handlers.ts` defines a separate
`HsmActionHandlers` class with *different* method signatures (it takes
a custom `HsmActionContext = { workItem, event, now }` and returns
`HsmActionResult = { patch, output }` — not the runtime signature).
That class has five methods:

- `createRunRecord(ctx)` — delegates to `executionService.createHsmRunRecord`
- `stampMeta(blockName)` — returns a curried handler that writes meta
- `closeGhIssue(ctx)` — reads + closes the GitHub issue, stamps meta
- `runArchiver(ctx)` — delegates to `executionService.archiveRunArtifacts`
- `kickOffPlanDrafter(ctx)` — spawns a background drafter via `PlanDrafterService.startDraft`

**None of these methods are called at runtime.** The class is
registered as a GraphModule provider (graph.module.ts:28, 39), it has
unit tests at `graph/__tests__/hsm-action-handlers.test.ts`, and
`createHsmRunRecord` exists on `ExecutionService` (line 1984) purely
to give this class a clean API to call. But nothing ever constructs it
in a way that would trigger those methods for a real dispatch.

The shadow class fails to satisfy the runtime contract in two ways:

1. **Signature mismatch.** The registered handler signature is
   `(workItem, event, ctx) => Promise<void>`. The class method
   signature is `(ctx: HsmActionContext) => Promise<HsmActionResult>`.
   No adapter wires the two together.
2. **Missing registration.** Even if the signatures matched, nobody
   calls `registerActionHandler("closeGhIssue", handlers.closeGhIssue.bind(handlers))`.

### 4.1 Shadow guards

`src/modules/graph/hsm-guard-handlers.ts` defines
`HsmGuardHandlers.prExistsForBranch(ctx)` — checks whether a PR exists
via `GitHubBatchCache.findPullRequestForBranch`. It's registered as a
GraphModule provider (graph.module.ts:29, 40) and has a test at
`hsm-action-handlers.test.ts:223`.

**It's also never called.** The SCXML chart's conditional transitions
use `cond="pr_exists"` / `cond="!pr_exists"`, and
`WorkItemHsmService.evaluateCondition` (work-item-hsm.service.ts:314)
evaluates those inline via a hardcoded switch on event payload:

```typescript
private evaluateCondition(cond: string, event: WorkItemHsmEvent | undefined): boolean {
  switch (cond) {
    case "pr_exists":
      return event?.type === "run.completed" && event.pr_exists === true;
    case "!pr_exists":
      return event?.type === "run.completed" && event.pr_exists === false;
    default:
      throw new Error(`Unsupported SCXML condition: ${cond}`);
  }
}
```

The guard is a pure function of the event data, not of the actual PR
state at dispatch time. The `HsmGuardHandlers` class was presumably
designed to replace this inline switch with registered async guards,
but that replacement never happened.

### 4.2 Shadow `createRunRecord` SCXML action

The chart has three transitions that declare `action="createRunRecord"`:

```xml
<state id="planned">
  <transition event="user.dispatch" target="in_progress" action="createRunRecord" />
</state>
<state id="ready">
  <transition event="user.dispatch" target="in_progress" action="createRunRecord" />
</state>
<state id="run_errored">
  <transition event="user.retry" target="in_progress" action="createRunRecord" />
</state>
```

**No handler for `"createRunRecord"` is ever registered.** At dispatch
time, `WorkItemHsmService` pushes `"createRunRecord"` into
`runtime.actions` (work-item-hsm.service.ts:326), the handler lookup
loop (line 144) finds nothing registered, and the state transition
completes with the action silently ignored.

The real run creation path is:

1. HTTP `POST /api/execution/launch` → `ExecutionService.launch`
2. `launch` calls `markWorkItemInProgressOnLaunch` which dispatches
   `user.dispatch` to the HSM — state moves `planned → in_progress`,
   no side effects
3. `launch` then directly calls the private `createRunRecord` helper
   (execution.service.ts:2007), persists the run, kicks off
   `executeRun`

So the chart says "entering `in_progress` creates a run" but the real
flow says "the service creates the run before asking the HSM to
transition, and the HSM doesn't know." The chart is aspirational.

### 4.3 Shadow `kickOffPlanDrafter`

The method exists on `HsmActionHandlers` (line 138) and wraps
`PlanDrafterService.startDraft` with a `persistDraftEnvelope` follow-
up. ADR 015 says it's meant to be spawned via SCXML `<invoke>` on
entry to the `drafting` state:

> `kickOffPlanDrafter` is asynchronous via SCXML `<invoke>`: entering
> `drafting` spawns a background drafter task; the HTTP request returns
> immediately; the task later dispatches `draft.completed` /
> `draft.failed` back into the HSM.

**The chart has no `<invoke>` element.** `WorkItemHsmService` doesn't
implement SCXML `<invoke>` semantics. The ADR contract was not
delivered.

The real drafting path is synchronous:

1. HTTP `POST /api/work-items/:id/transition` with `user.start_draft`
   → `WorkItemsController.routeStartDraft`
2. Controller calls `PlansService.prepare(id)` which synchronously
   awaits `PlanDrafterService.draft(workItem, issueBody)` — that's
   one blocking HTTP request for as long as the drafter takes
3. Controller returns after state transition completes

The async `<invoke>` version from ADR 015 is a feature that was
designed but never built. The shadow `kickOffPlanDrafter` method gives
the appearance that it exists.

### 4.4 What to do about the shadow vocabulary

Phase 1 in the current plan was "rewrite HsmActionHandlers to become
the real path for `closeGhIssue` + `runArchiver`." That's the right
goal but it needs to be more specific:

1. **Move `HsmActionHandlers` out of GraphModule.** The class injects
   `ExecutionService`, `GitHubService`, `GitHubBatchCache`,
   `PlanDrafterService`, `PlansService` — four services from three
   modules. Its natural home is **ExecutionModule** (where it has
   direct access to ExecutionService + GitHubBatchCache and can
   forwardRef Plans + GitHub from there).
2. **Rewrite the method signatures** to match the runtime
   `HsmActionHandler` contract `(workItem, event, context) =>
   Promise<void>` — mutating `context.handler_data`,
   `context.patch_overrides`, `context.meta` in place rather than
   returning a custom envelope.
3. **Add `implements OnModuleInit`** and register the handlers in the
   class's own `onModuleInit`. The existing `ExecutionService.onModuleInit`
   inline registrations move into this class.
4. **Delete `HsmGuardHandlers`.** Its one method is dead; the real
   guard lives inline in `WorkItemHsmService.evaluateCondition`. If
   that inline switch is unsatisfying, replace it in a later phase —
   but the dead class has to go.
5. **Delete the `createRunRecord` SCXML action reference** from the
   chart (keep the three `user.dispatch`/`user.retry` transitions but
   drop `action="createRunRecord"`). The chart becomes honest that run
   creation is ExecutionService's job, not the HSM's. Alternatively,
   genuinely migrate run creation into the HSM — but that's a bigger
   refactor and changes the launch flow in ways that affect error
   handling.
6. **Delete `HsmActionHandlers.kickOffPlanDrafter`** unless SCXML
   `<invoke>` support is being built in the same PR.

Net forwardRef impact of the full Phase 1 above: **moving
`HsmActionHandlers` from GraphModule to ExecutionModule removes
Graph's reason for importing ExecutionModule** — because the three
Graph-side cross-module reaches (`HsmActionHandlers.executionService`,
`HsmActionHandlers.githubService`, `HsmActionHandlers.githubBatchCache`)
move with the class. `GraphModule → forwardRef(ExecutionModule)` drops.

It also removes `GraphModule → forwardRef(PlansModule)` for the same
reason (HsmActionHandlers was the only consumer of
`PlansService.persistDraftEnvelope` via `kickOffPlanDrafter`, and
WorkItemsController still injects it at line 49 — Phase 2's job to
remove).

It does **not** remove `GraphModule → forwardRef(GitHubModule)` —
`HsmGuardHandlers` still uses `GitHubBatchCache`, but once we delete
that class, nothing in Graph uses GitHubBatchCache. Wait — let me
re-check. Yes: `hsm-guard-handlers.ts:8` is the only Graph-side
consumer of `GitHubBatchCache`. Deleting the class removes the last
Graph → ExecutionModule dependency entirely (since GitHubBatchCache
lives in ExecutionModule).

**After a full Phase 1 (move + rewrite + delete guards): GraphModule
drops from 3 forwardRefs to 1** (`forwardRef(GitHubModule)` stays
because `WorkItemsController` still needs nothing from Github — wait,
it doesn't. Let me check the controller again.)

Double-checking: `WorkItemsController` imports `ExecutionService` and
`PlansService` but not `GitHubService`. So after Phase 1 +
HsmActionHandlers move:

- GraphModule provides: `SQLiteService, WorkItemsService, EdgesService,
  GraphService, GraphEventsService, GraphWriterService,
  WorkItemHsmService` and the two controllers `WorkItemsController,
  EdgesController, GraphController`.
- GraphModule needs to import what its providers/controllers inject.
  `WorkItemsController` still injects ExecutionService + PlansService
  at lines 47/49 — so `forwardRef(Execution)` and `forwardRef(Plans)`
  would have to stay until Phase 2 removes those injections.
- `HsmGuardHandlers` deletion removes the GitHubBatchCache dependency.
- If Phase 1 does all of: move HsmActionHandlers, delete
  HsmGuardHandlers, and delete `createRunRecord`/`kickOffPlanDrafter`
  from the shadow class — then **GraphModule still forwardRef's
  Execution + Plans** (for the controller), but forwardRef(GitHub) is
  gone.

So Phase 1 removes **1** forwardRef: `GraphModule →
forwardRef(GitHubModule)`. That's less exciting than the estimate
above but it's accurate. The bigger wins wait for Phase 2.

---

## 5. Smell #3: `WorkItemsController` cross-domain reach

**File:** `src/modules/graph/work-items.controller.ts`
**Size:** 177 lines
**Constructor:** injects 4 services including two from other modules
via `forwardRef`.

```typescript
// graph/work-items.controller.ts:44
constructor(
  @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
  @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
  @Inject(forwardRef(() => ExecutionService))
  private readonly executionService: ExecutionService,
  @Inject(forwardRef(() => PlansService))
  private readonly plansService: PlansService,
) {}
```

The cross-module calls all live inside `transition()` (line 88):

| Line | Call | Why it's wrong |
|---:|---|---|
| 120 | `executionService.cancelWorkItem({…})` | Cancellation is an execution-owned workflow (plan dir archival, github close, HSM dispatch) but the HTTP handler for it lives in GraphModule because "cancel a work item" routes through `/api/work-items/:id/transition`. |
| 139 | `plansService.prepare(id)` | Plan drafting is Plans-owned. Same structural issue. |
| 144 | `plansService.reopen(id)` | Plan reopen is Plans-owned. Same. |
| 149 | `executionService.transitionInProgressToDrafting(id)` | Thin HSM dispatch wrapper that Execution owns for historical reasons. |
| 162 | `executionService.transitionInProgressToReady(id)` | Same. |

The controller has two private helpers, `routeStartDraft` and
`routeInvestigate`, that dispatch based on the work item's current
state (lines 135–172). **This is business logic in a controller.** The
controller is doing: "if state is X, call PlansService; if Y, call
ExecutionService; if Z, call HSM directly" — exactly the routing that
a command bus + handler resolution should do.

Phase 2's job: replace every cross-module call with a `CommandBus.execute(new FooCommand(...))` call. Handler classes live in the module that owns the behavior (ExecutionModule for cancel/delete/transition; PlansModule for prepare/reopen). `WorkItemsController` ends up injecting only:

1. `WorkItemsService` (same module — for list, get, create, update, delete)
2. `WorkItemHsmService` (same module — for `getEnabledEvents` + direct dispatch on `user.defer` / `user.undefer`)
3. `CommandBus` (from `@nestjs/cqrs`)

Zero forwardRefs in the controller, and `forwardRef(() => PlansModule)`
comes out of `graph.module.ts` (since nothing else in Graph needs
Plans after the HsmActionHandlers move from Phase 1).

The `routeStartDraft` / `routeInvestigate` helpers die — their logic
moves into the handlers. Or rather, it splits: the *command the user
dispatched* becomes more specific on the HTTP side (the controller
decides "based on current state, dispatch PreparePlanCommand or
ReopenPlanCommand or TransitionInProgressToDraftingCommand"), and the
handler bodies become one-liners that call the service. That's
arguably just moving the branch — but the win is that each branch now
routes through a type-checked, named command that has a single
handler registered with the bus.

There is a genuine design question Phase 2 has to answer: **should the
controller branch on state and dispatch a specific command, or should
it dispatch a single generic `TransitionWorkItemCommand(event)` and
let the handler branch?** The former couples the controller to state
knowledge; the latter moves that knowledge into a handler. I'd argue
for the latter because the handler lives in the module that knows the
state machine, and the controller becomes dumber.

Either way, **net forwardRef change for Phase 2: −1**
(`GraphModule → forwardRef(PlansModule)` goes away, because
`WorkItemsController` no longer injects `PlansService` directly).
`GraphModule → forwardRef(ExecutionModule)` *also* goes away if Phase
1 already ran and removed the HsmActionHandlers dependency on
ExecutionService. Combined Phase 1 + Phase 2 removes 3 of Graph's 3
imports, and GraphModule stops importing anything except its own
providers.

---

## 6. Smell #4: `ExecutionService`'s inline HSM handler registration

This is a specific sub-smell of Smell #1 and Smell #2 but deserves its
own call-out because it's the most embarrassing part of the current
wiring.

`ExecutionService.onModuleInit` is responsible for:

1. Running startup reconcile (line 118) — OK
2. Rehydrating recent runs from disk (line 126) — OK
3. **Registering HSM action handlers as inline closures** (lines 134,
   154) — this is wrong

The closures do real work. `runArchiver` is 45 lines: capture run
snapshot, move plan dir, call `archiveRunArtifactsForWorkItem`, stamp
meta, populate `patch_overrides.archive_path`, write `handler_data.archive_result`.
It's an important pipeline. It lives inside an anonymous arrow
function inside the constructor's lifecycle hook.

Everything about that placement is hostile to maintenance:

- **Unnamed.** No line number shows "this is `runArchiver`" in grep
  output; you have to know the SCXML action name.
- **Untestable in isolation.** The only way to exercise the code is
  through a full HSM dispatch with the real `ExecutionService`
  constructed by the Nest test module.
- **Untyped context.** The closure captures `this`, including private
  helpers like `captureRunSnapshotForWorkItem`. Extracting the logic
  later means chasing every captured reference.
- **Duplicated with the shadow class.** The shadow
  `HsmActionHandlers.runArchiver` (hsm-action-handlers.ts:122) does
  nearly the same thing, through a different API shape, with its own
  tests — and neither runs in production.

**Phase 1 fix:** move the two closures into real class methods on the
(moved-to-Execution) `HsmActionHandlers` class with matching runtime
signatures, then delete the inline closures. The class's
`onModuleInit` does the `registerActionHandler` calls. Tests already
exist — they just need to be rewritten to match the new signature.

---

## 7. Smell #5: `SQLiteService` lives in `GraphModule`

**File:** `src/modules/graph/sqlite.service.ts`
**Size:** 136 lines (tiny — it's a thin wrapper around `initManifest`
plus startup schema migration for the HSM-aligned state CHECK constraint).

SQLiteService is referenced by:

- `graph/work-items.service.ts:29` (same module, fine)
- `graph/graph-writer.service.ts:56` (same module, fine)
- `graph/graph.service.ts:14` (same module, fine)
- `graph/edges.service.ts` (same module, fine)
- **`github/github.service.ts:119`** (cross-module)
- **`settings/settings.service.ts:39`** (cross-module)
- **`planning/context.service.ts:31`** (cross-module, but PlanningModule imports Graph directly so no cycle)

Because it's in GraphModule, any module that needs a DB handle has to
import GraphModule. That forces:

- `GitHubModule → GraphModule` (direct, OK — because GitHub also
  needs WorkItemsService)
- `SettingsModule → forwardRef(GraphModule)` (defensive — SettingsService
  only needs SQLiteService but it has to drag the whole GraphModule
  along, and Settings → Graph creates a transitive cycle with
  Execution → Settings and Plans → Settings, which is why all three of
  those sides use forwardRef)
- `PlanningModule → GraphModule` (direct — Planning already needs
  GraphService + EdgesService + WorkItemsService, so SQLite is
  incidental)

**Phase 6 in the current plan is "move GitHubBatchCache + Scheduler
into GitHubModule."** It should be expanded to also create a
`PlatformModule` (or `InfraModule`) that owns `SQLiteService`. The
benefits:

- `SettingsModule` imports `PlatformModule` directly. The
  `Settings → Graph → …` transitive cycle vanishes. That means
  `Execution → Settings (fwd)` becomes redundant (nothing cycles
  through it anymore) and `Plans → Settings (fwd)` becomes redundant.
  **Remove 2 forwardRefs.**
- `SettingsModule` itself drops `forwardRef(GraphModule)`. **Remove 1
  forwardRef.**
- `GitHubModule` can drop its import of `GraphModule` if it also
  stops needing `WorkItemsService`. But GitHubService DOES need
  WorkItemsService (github.service.ts:120) for `listByRepoIssueNumber`,
  `listByRepoBranch`, etc. It can't drop Graph just because SQLite
  moved. So Github still imports Graph — but at least it can do so
  directly instead of through a forwardRef (which it already does).

So the SQLiteService relocation is worth **~3 forwardRefs** on its
own. Combined with Phase 6's original scope (moving GitHubBatchCache
home), it's the highest-leverage single-phase cleanup.

---

## 8. Smell #6: `GitModule` is dead

**Files:**
- `src/modules/git/git.module.ts` (8 lines)
- `src/modules/git/git.service.ts` (161 lines)
- `src/modules/git/__tests__/git.service.test.ts` (~135 lines)

`GitService` provides:

- `discoverRepo(path)` — resolves a local filesystem path to a GitHub
  repo slug by shelling out to `git -C <path> rev-parse --show-toplevel`
  + `git remote get-url origin`, then parsing the remote.
- `suggestArtifactRoot(repoRoot)` — reads `AGENTS.md` / `CLAUDE.md` for
  a `**context-path**:` directive and returns a suggestion.
- Four exported pure helpers: `parseGitHubRepoSlug`, `parseContextPath`,
  `parseContextPathFile`, `sanitizeConfiguredPath`, `expandUserPath`,
  `resolveConfiguredPath`.

**Nothing imports `GitModule` into `AppModule`** — verify at
`src/app.module.ts:13` which imports `ExecutionModule, GraphModule,
HealthModule, GitHubModule, PlanningModule, PlansModule,
ReconciliationModule, SettingsModule` — no GitModule.

`GitService` is never instantiated at runtime. Its tests pass because
vitest constructs it directly (no Nest container). The HTTP surface it
would power (a "point Studio at a local repo and get artifact root
suggestions" wizard) was never built.

**Phase 8's job:** delete `git.module.ts`, `git.service.ts`, and the
test file. Net: ~305 lines of dead code removed. The four pure helpers
(parseGitHubRepoSlug etc.) are *also* not used elsewhere — a grep for
`parseGitHubRepoSlug` returns only the file itself and the test. Pure
dead code.

Separately: should any future work want these helpers, they're
trivially re-constructible. No risk in deletion.

---

## 9. Smell #7: two reconcilers, wrongly named

**Two services with `reconcile` in the name do completely different
things:**

### 9.1 `ReconciliationService` — drift report generator

**File:** `src/modules/reconciliation/reconciliation.service.ts`
**Size:** 181 lines

Generates "reconciliation reports" that compare a work item's
`predicted_files` against its `actual_files` and classify the drift:

- `no_prediction` — execution changed files with no scope recorded
- `no_actual_changes` — files predicted but run hasn't run
- `exact_match` — prediction and reality lined up
- `overprediction` — predicted files not touched
- `unpredicted_change` — changed files not predicted
- `mixed_drift` — both sides missed

**This is not reconciliation in any meaningful sense.** It's a drift
report — a post-hoc comparison between prediction and reality, with no
mutation of state. The output feeds the planner's learning loop
(via the `reconciliation_query` planning tool, which
`PlanningService.createReconciliationQueryTool` at planning.service.ts:
777 exposes to the LLM so it can say "explain why this work item's
scope predictions drifted"). But nothing is reconciled — no state is
written, no two sources are brought into agreement.

**The correct name is `PlanDriftReportService` or just
`PlanDriftService`.** `ReconciliationModule` becomes `DriftReportModule`.
The HTTP surface `/api/reconciliation/reports` could keep its URL for
backwards compatibility (the frontend's `ReconciliationPanel.svelte`
calls it), or migrate to `/api/drift-reports/*` with a redirect for
one release.

### 9.2 `WorkItemReconcilerService` — actual reconciler

**File:** `src/modules/execution/work-item-reconciler.service.ts`
**Size:** 465 lines

Joins four data sources to compute a derived "next action" per work
item:

1. Graph state (`work_items.state`)
2. On-disk runs (`runs/<id>/status.json`)
3. GitHub PR truth (via `GitHubBatchCache.findPullRequestForBranch`)
4. Worktree state (via git commands)

The decision table (`decideNextAction` at line 405) picks one of:
`open_pr | awaiting_review | close_out | relaunch | investigate |
abandon | none`. It also calls `WorkItemHsmService.getEnabledEvents`
to surface "what user events does the chart accept from this state",
which the Execute tab turns into button labels.

Plus `runStartupReconcile` (line 239) which runs orphan detection on
disk and emits a summary — called from `ExecutionService.onModuleInit`
at line 118.

**This IS reconciliation.** Graph, disk, and GitHub are independent
sources of truth that can drift; the reconciler joins them and surfaces
the result. The name is correct, the module placement is slightly off
(it could arguably live in its own module alongside the batch cache,
but it's tightly coupled to execution's disk layout so the current
home is defensible).

### 9.3 Why the rename matters

Today, reading the codebase, you encounter both
`ReconciliationService` (named, module-level) and
`WorkItemReconcilerService` (named, provider-level in execution) and
assume they're related. They're not. One is backward-looking analytics;
the other is forward-looking truth-joining. A new contributor has to
read both to figure that out.

The rename is mechanical: change the class name, change the file name,
change the module name, update every import, update the controller and
the URL (or keep the URL — pick one). Phase 8's job.

There's a sneaky bonus: after the rename,
`ReconciliationModule → ExecutionModule` (at `reconciliation.module.ts:8`)
can possibly be removed — `ReconciliationService` currently injects
`ExecutionService` (line 17) only to call `listRecentRuns()`, which
filters for completed runs. If the run store becomes an independent
sub-service in Phase 4, `DriftReportService` could inject that
sub-service directly and drop the ExecutionModule import. Net: **−1
direct import** (not a forwardRef but still cleanup).

---

## 10. Smell #8: `PlanningService` tool monolith

**File:** `src/modules/planning/planning.service.ts`
**Size:** 1378 lines

Responsibilities in descending line count:

| Range | Responsibility |
|---:|---|
| 360–801 | **Ten tool definitions** — `graph_query`, `propose_mutations`, `graph_mutate`, `memory_read`, `memory_write`, `delegate_subagent`, `github_read`, `github_create_issue`, `github_sync`, `reconciliation_query`. Each is an inline `defineTool({...})` call with schema, prompt snippets, guidelines, and an `execute` function. Roughly 440 lines total. |
| 803–903 | Proposal / memory / GitHub sync normalization helpers |
| 905–990 | Mutation type conversion (`toGraphMutation`) |
| 992–1064 | Staging / approval lifecycle helpers (`updateActiveProposalAfterApply`, etc.) |
| 1065–1255 | Issue ID alias tracking for accumulated proposals |
| 1257–1321 | Session snapshot projection (`projectSessionEntries`, `messageContentToText`, `stripStudioContext`) |
| 1322–1378 | Misc helpers (`now`, `getErrorMessage`, `isStreamableEvent`) |

Plus the top (1–358): session lifecycle, stream management, approval
endpoints for proposals/memory/github-sync, and `handleSessionEvent`.

**Phase 7 in the current plan: extract each tool into its own file.**
The shape is clear: each tool needs access to the services it calls
(`graphService`, `memoryService`, `githubService`, `subAgentService`,
`reconciliationService`, `graphWriter`), plus some shared state (the
proposal counter, the active-proposal-id tracker, the emit helper).

A clean extraction looks like:

```
src/modules/planning/tools/
  ├── graph-query.tool.ts
  ├── propose-mutations.tool.ts
  ├── graph-mutate.tool.ts
  ├── memory-read.tool.ts
  ├── memory-write.tool.ts
  ├── delegate-subagent.tool.ts
  ├── github-read.tool.ts
  ├── github-create-issue.tool.ts
  ├── github-sync.tool.ts
  ├── reconciliation-query.tool.ts
  └── tool-registry.ts          — exports createPlanningTools(deps)
```

Each file exports a `createXxxTool(deps) => Tool` factory. The
`deps` bag contains whatever services + state that specific tool needs.
`createPlanningTools(deps)` in `tool-registry.ts` composes the array
and is the single call site in `PlanningService.createOrResumeSession`.

The tricky part is the shared state for proposal accumulation — the
`issueIdAliases` map + `activeProposalId` + `proposals` map are
shared between `propose_mutations`, `graph_mutate`, and
`github_create_issue`. Either:

1. Keep that state on `PlanningService` and pass it into the tool
   factories as a mutable reference bag, or
2. Extract it to a `ProposalStateService` that the tools inject.

Option (2) is cleaner. It's also Phase 7's job.

After extraction, `PlanningService` drops to roughly **400–500 lines**
covering: session lifecycle, stream/SSE, approval endpoints,
`handleSessionEvent`, and the thin `sendMessage` / `getSessionSnapshot`
surface. Everything else moves out.

No forwardRef changes here — `PlanningModule` is a leaf (nothing
imports it). It's pure code-size reduction and per-tool testability.

---

## 11. Smell #9: duplicated run scaffolding

`ExecutionService` owns `recentRuns: ExecutionRunRecord[]` (16 entries),
`upsertRecentRun`, `writeMetadata`, `writeStatus`, `writeSummary`,
`appendEvent`, `emitRun`, `hydrateRecentRunsFromDisk`.

`SubAgentService` owns `recentRuns: SubAgentRunRecord[]` (12 entries),
`upsertRecentRun`, `writeMetadata`, `writeStatus`, `writeSummary`,
`appendEvent`, `onStatus/onResult` hook pattern.

These are nearly identical responsibilities over different record
types. Both:

1. Maintain a capped in-memory buffer keyed by `run_id`
2. Write `runs/<run_id>/status.json` for restart recovery
3. Write `runs/<run_id>/metadata.json` for static fields
4. Write `runs/<run_id>/events.jsonl` per-event
5. Write `runs/<run_id>/summary.md` (ExecutionService only, but
   SubAgentService does a simpler version)
6. Hydrate from disk on boot

A generic `RunStore<T extends { run_id: string; updated_at: string; artifact_dir: string }>`
could unify both. Each service wraps the generic store with its own
type parameters + record builders.

This is not in the current 9-phase plan. It's worth Phase 9 / review
pass consideration because the duplication is real but it's not
blocking anything. Low priority; add it to the known-unaddressed list.

---

## 12. Revised phase plan

The original 9-phase plan was written with intuition; this rev is
grounded in the code.

### Phase 0 — Install `@nestjs/cqrs` + smoke test (NO CHANGE)

`npm install @nestjs/cqrs`, register `CqrsModule` in `AppModule`, write
a throwaway smoke test that dispatches a trivial command through the
bus and asserts the handler runs. **Zero production code touched.**

**ForwardRef impact:** 0. **Value:** platform sets up the seam Phase 2+
depend on.

### Phase 1 — Kill the HSM shadow vocabulary (REVISED)

**This is the most changed phase.** The original Phase 1 was "rewrite
HsmActionHandlers to become the real path for closeGhIssue + runArchiver."
The revised scope:

1. Move `src/modules/graph/hsm-action-handlers.ts` to
   `src/modules/execution/hsm-action-handlers.ts`.
2. Rewrite the class to implement runtime handler signatures — method
   bodies take `(workItem, event, context: HsmActionHandlerContext)`
   and return `Promise<void>`, mutating the context in place.
3. Add `implements OnModuleInit` + register the handlers from the
   class's own `onModuleInit` via `hsmService.registerActionHandler`.
4. Remove the inline `registerActionHandler` closures from
   `ExecutionService.onModuleInit` (lines 134, 154).
5. Delete `HsmActionHandlers.createRunRecord` method — it's shadow.
   Delete the `action="createRunRecord"` references from the SCXML
   chart (the three `user.dispatch` / `user.retry` transitions). Run
   creation stays owned by `ExecutionService.launch`.
6. Delete `HsmActionHandlers.kickOffPlanDrafter` — the SCXML
   `<invoke>` pathway doesn't exist, and the synchronous path via
   `PlansService.prepare` is fine for now.
7. Delete `src/modules/graph/hsm-guard-handlers.ts` entirely — dead
   class. Update the guard-handlers test file either to cover the
   inline `WorkItemHsmService.evaluateCondition` switch directly or
   delete it.
8. Remove `HsmActionHandlers` and `HsmGuardHandlers` from GraphModule
   providers/exports.
9. Add the moved `HsmActionHandlers` to ExecutionModule providers.
10. Update `graph/__tests__/hsm-action-handlers.test.ts` to match the
    new signature (or move the test file to the execution module
    alongside the class).

**ForwardRef impact:** −1. `GraphModule → forwardRef(GitHubModule)`
goes away because the only Graph-side consumer of `GithubService` and
`GithubBatchCache` was `HsmActionHandlers`/`HsmGuardHandlers`, and
they're gone. Count: **11 → 10.**

Other `forwardRef` wrappers stay because `WorkItemsController` still
injects Execution + Plans (Phase 2's job).

### Phase 2 — Route `WorkItemsController` through the command bus

As written in the existing phase-2 doc, minus the forwardRef count
fudge. Create six commands (`CancelWorkItemCommand`,
`DeleteWorkItemCommand`, `TransitionInProgressToReadyCommand`,
`TransitionInProgressToDraftingCommand`, `PreparePlanCommand`,
`ReopenPlanCommand`) with handler classes in their owning modules.
`WorkItemsController` injects only `CommandBus` + its two same-module
services. Mirror the same migration in `ExecutionController` for
consistency.

**ForwardRef impact:** −2. `GraphModule` drops its remaining
forwardRefs on Execution and Plans. Count: **10 → 8.**

### Phase 3 — Extract `RunDispositionService` + disposition handlers

The merged-PR disposition flows (`closeMergedPullRequest`,
`archiveAndCloseMergedPullRequest`, `cancelWorkItem`, `deleteWorkItem`)
are ~800 lines of `ExecutionService` that cluster around: plan dir
archival, run snapshot capture, run-splice finalizers, HSM dispatch
for the terminal transitions.

1. Create `RunDispositionService` in ExecutionModule.
2. Move `captureRunSnapshotForWorkItem`, `removeRunsForWorkItem`,
   `movePlanDirToArchives`, `archiveRunArtifacts`,
   `assertWorkItemInMergedPr`, `assertNoActiveRunForWorkItem`,
   `assertCancelEligible`, `assertDeleteEligible`, `leafState` into it.
3. `ExecutionService.closeMergedPullRequest` and
   `.archiveAndCloseMergedPullRequest` become thin callers of the
   sub-service (or move to command handlers fully — Phase 2 created
   handlers; Phase 3 fills them with the extracted logic).
4. Cancel / delete flows likewise.
5. Update `HsmActionHandlers.runArchiver` (the one that lives in
   ExecutionModule after Phase 1) to call
   `runDispositionService.archiveRunArtifactsAction` instead of
   reaching into `ExecutionService`'s private helpers.

**ForwardRef impact:** 0 (all movement is within ExecutionModule).
**Value:** ~800 lines leave the god class. It drops from 3286 to
~2500 lines.

### Phase 4 — Extract remaining ExecutionService sub-services

Carve out `WorktreeService`, `PullRequestService`, `ScratchpadService`,
`RunInteractionService`, `RunStore`. Each is its own file in
ExecutionModule, each has unit tests. `ExecutionService.launch` and
`executeRun` stay but become thin orchestrators calling the sub-
services.

**ForwardRef impact:** 0. **Value:** ExecutionService drops from
~2500 lines (after Phase 3) to ~400–800 lines.

### Phase 5 — Event-driven cross-context calls

Replace direct service calls between Execution ↔ Graph with
`@nestjs/cqrs` events (`WorkItemFinalizedEvent`, `RunCompletedEvent`,
etc.). Handlers subscribe to events instead of services calling each
other.

This phase's specifics depend on how Phases 3–4 look once landed. The
current direct calls to investigate:

- `ExecutionService.syncMergedPullRequest` → `hsmService.dispatch` +
  `workItemsService.update` + `githubBatchCache.upsertPullRequest`
  (execution.service.ts:630, 642, 652)
- `GitHubService.withPullRequestReconciliation` → `workItems.update`
  (github.service.ts:565) + `pullRequestTruthRefresher` callback
  (line 568) back to ExecutionService

Some of these become events. Some remain direct calls because the
caller needs the return value synchronously. Phase 5 picks the ones
where fire-and-forget is adequate.

**ForwardRef impact:** probably 0 or negative. Hard to predict exactly
without the Phase 3/4 outcome.

### Phase 6 — Move SQLiteService to a platform module + move GitHubBatchCache to GitHubModule

Two related changes bundled because they share the "stop GraphModule
from being an infrastructure hub" goal.

1. Create `src/modules/platform/platform.module.ts` with
   `SQLiteService` as its only provider. Update every consumer
   (`WorkItemsService`, `GraphWriterService`, `GraphService`,
   `EdgesService`, `GitHubService`, `SettingsService`,
   `ContextService`) to import from the new location.
2. Remove `SQLiteService` from GraphModule.
3. Delete `SettingsModule → forwardRef(GraphModule)` — replaced by
   `SettingsModule → PlatformModule` (direct, no cycle).
4. Delete `Execution → forwardRef(Settings)` — the cycle that
   necessitated it is gone.
5. Delete `Plans → forwardRef(Settings)` — same.
6. Move `GitHubBatchCache` + `GitHubCacheScheduler` + their
   controller and tests from ExecutionModule to GitHubModule. Update
   consumers.
7. Update GraphModule: `GitHubBatchCache` is no longer in
   ExecutionModule — if anything in Graph still references it (after
   Phase 1 deletes HsmGuardHandlers, nothing should), adjust.

**ForwardRef impact:** −3 (Settings→Graph, Execution→Settings,
Plans→Settings). Count: **8 → 5.** If Phases 3–4 also let us drop
`Execution → forwardRef(Plans)` and `Plans → forwardRef(GitHub)`, more
come out.

### Phase 7 — Extract planning tool registry

As described in §10. ~10 tool files + one `tool-registry.ts` +
possibly a `ProposalStateService`. PlanningService drops to ~400
lines.

**ForwardRef impact:** 0. **Value:** each tool is independently
reviewable and testable; diffs to one tool don't touch a 1378-line
file.

### Phase 8 — Delete dead code + rename reconciliation

1. Delete `src/modules/git/` — module, service, tests.
2. Delete any remaining shadow HSM vocabulary Phase 1 missed.
3. Rename `ReconciliationService` → `DriftReportService`,
   `ReconciliationModule` → `DriftReportModule`. URL can stay or
   migrate to `/api/drift-reports` with a redirect.
4. Update the planner tool `reconciliation_query` → `drift_report_query`
   (or keep the tool name for compatibility with the planner's
   memory; LLM memory of tool names is a real concern).
5. Check for any dead frontend components (e.g. old Svelte components
   referenced from removed routes).

**ForwardRef impact:** 0 or −1 (`ReconciliationModule → ExecutionModule`
direct import might become removable). **Value:** codebase shrinks,
names match meanings.

### Phase 9 — Review pass

Whatever looks wrong after Phase 8. Likely candidates:

- **Unused defensive forwardRefs.** After Phases 1–6, some remaining
  `forwardRef()` wrappers may have been for cycles that no longer
  exist. Unwrap each one, run tests, see if Nest complains. Keep only
  the ones genuinely needed.
- **`ExecutionService` ↔ `SubAgentService` run store dedup** from §11.
- **`GitHubService` ↔ `GitHubBatchCache` redundant ownership** —
  after Phase 6 both live in GitHubModule; consider whether one
  should be a facade over the other.
- **`PlansService.persistDraftEnvelope` call from deleted
  `kickOffPlanDrafter`** — make sure no caller references the deleted
  method (Phase 1 should handle this but double-check).
- **`ExecutionService.onModuleInit`'s callback registration** to
  `GitHubService.registerPullRequestTruthRefresher` (execution.service.ts:
  102) — this is a direct function-pointer handshake that predates any
  command bus. After Phase 5, it may become
  `GitHubPullRequestTruthRefreshedEvent` dispatched on the event bus
  and subscribed by ExecutionService. Or not — the callback is fine,
  just worth documenting the choice.

### ForwardRef trajectory

```
Start:     11
Phase 1:   10  (Graph → GitHub)
Phase 2:    8  (Graph → Execution, Graph → Plans)
Phase 3:    8  (internal, no change)
Phase 4:    8  (internal, no change)
Phase 5:    7  (one or two event-driven breaks, conservative)
Phase 6:    5  (Settings → Graph, Execution → Settings, Plans → Settings)
Phase 7:    5  (internal, no change)
Phase 8:    5  (dead code, reconciliation rename)
Phase 9:    0–2  (defensive cleanup)
```

Target: **under 2 forwardRefs by end of Phase 9**, ideally zero.

---

## 13. What this assessment replaces

- `docs/proposals/README.md` — the phase table is correct in spirit
  but the "net outcome" column was written before this assessment; the
  per-phase forwardRef math was wrong by 2 in places.
- `docs/proposals/phase-0-platform-bus.md` — essentially correct, no
  substantive changes needed.
- `docs/proposals/phase-1-hsm-action-handlers.md` — incorrect scope.
  Reads like "rewrite HsmActionHandlers in place"; the correct Phase 1
  moves the class to ExecutionModule and deletes the guard handlers.
  Rewrite after this assessment is accepted.
- `docs/proposals/phase-2-work-items-controller-command-bus.md` —
  correct in intent; the forwardRef arithmetic was off by 1 (claimed
  −1 but should be −2 if Phase 1 already removed Graph → GitHub and
  this phase also removes Graph → Execution and Graph → Plans). Minor
  fix.

The 2–3 hours spent drawing PlantUML diagrams under
`docs/diagrams/` produced a useful component overview but did not
feed this assessment's specific findings. The diagrams remain accurate
enough to use as reference material during phase execution.

---

## 14. What this assessment does NOT cover

- **Frontend architecture.** `web/src/components/*.svelte` and
  `web/src/lib/*.js` have their own structure that is out of scope.
  Some components will need updates when backend URLs or payload
  shapes change in Phase 8; those are per-phase follow-ups.
- **SCXML chart rewrites.** If someone wants to add SCXML `<invoke>`
  support for the plan drafter, that's a separate project. This
  assessment assumes the chart stays at its current capability level
  modulo the `createRunRecord` action removal in Phase 1.
- **Database migrations.** The schema is driven by
  `initManifest(manifestPath)` in `src/lib/manifest-core.ts` plus the
  startup migration in `sqlite.service.ts:migrateWorkItemStates`. No
  phase in the plan touches schema. If one did, that's a cross-cutting
  concern that needs its own review.
- **Test harness patterns.** Several tests use
  `Object.create(ServicePrototype)` to bypass Nest DI and stub
  collaborators. This works but is fragile (changes to the class
  initialization order break the harness). A test-infrastructure
  cleanup is valuable but is not part of this migration.

---

## 15. Acceptance criteria for this document

- [ ] The 11 forwardRefs are enumerated with file:line references.
      Verified at §2.1.
- [ ] Every smell has at least one code pointer (file + line range).
      Verified at §3–§11.
- [ ] The migration-vs-rebuild decision is argued, not asserted.
      Verified at §1.
- [ ] Each phase has a forwardRef arithmetic. Verified at §12.13.
- [ ] The document is self-contained — someone reading this without
      having seen the codebase can form an accurate mental model of
      what's wrong and what to do. Verified by writing this review
      item last.

If all five check, this assessment becomes the reference for future
phase execution. Future per-phase docs can be much shorter because
they assume this context.
