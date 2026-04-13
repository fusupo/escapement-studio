# Phase 5 — Event-driven cross-context calls, picked per event

**Status:** proposed
**Predecessors:** [phase-4-execution-sub-services.md](phase-4-execution-sub-services.md)
**Successors:** [phase-6-platform-module.md](phase-6-platform-module.md)
**Estimated effort:** 2–3 days
**Net forwardRef change:** **−1** (8 → 7)

## Motivation

Phases 3 and 4 extracted sub-services from the god class but left
every cross-module call as a direct method invocation. The command
bus from Phase 0/2 handles HTTP-adapter reach-across (a service in
one module needs to invoke logic owned by another in response to
an HTTP request). It does not handle **broadcast facts**: a single
event that N independent consumers want to react to, where none of
them knows about the others.

Three concrete cases in the codebase today want that shape:

1. **"A work item entered `merged_pr`."** When the GitHub cache
   scheduler dispatches `gh.pr_merged` through the HSM, the state
   transition succeeds and then… nothing else happens automatically.
   The merged-PR state sits until an operator clicks "Close" or
   "Archive and close." But multiple consumers could legitimately
   react: the notifications UI badge count, a future reconciliation
   report, the drift report service in Phase 8. Today any new
   consumer has to be wired into the scheduler directly.
2. **"A run completed successfully."** `ExecutionService.executeRun`
   finishes, calls `syncActualFiles`, writes `runs/<id>/outputs/response.json`,
   updates the run to `completed`, emits `execution_result` over SSE.
   Today that sequence is inlined at the bottom of the 280-line
   coroutine. Phase 4 moves it into the orchestrator but doesn't
   split it. A future consumer (e.g. auto-staging the managed block
   sync on successful completion) has to edit `executeRun`.
3. **"GitHub PR truth was refreshed."** `GitHubService` has a bespoke
   `registerPullRequestTruthRefresher(fn)` callback seam that
   `ExecutionService.onModuleInit` uses to register
   `refreshPullRequestTruth`. It's a one-subscriber push pattern —
   event-shaped but hand-rolled. Moving it to the event bus would
   give it a name and let `RunDispositionService` or a future
   watcher subscribe too.

This phase picks **one event per case** and writes them properly,
rather than a blanket sweep. Per-event analysis:

- **Durable vs reactive.** If a subscriber is load-bearing (must not
  fail silently), event fire-and-forget is wrong. Use a command
  dispatched from the primary reactor instead, or keep the direct
  call.
- **Ordering.** If one subscriber's completion is a precondition for
  another, events are wrong — use an explicit pipeline.
- **Error semantics.** If the primary action should roll back when a
  subscriber throws, events are wrong — use synchronous direct
  calls or a saga pattern.

[`assessment.md`](assessment.md) §13 and the CQRS-is-glue discussion
after that flag this phase as the one most likely to overreach. It's
small on purpose.

## Scope

**In:**

- Add three event classes:
  - `WorkItemMergedEvent { workItemId, pullRequest }`
  - `RunCompletedEvent { runId, workItemId, changedFiles, summary }`
  - `PullRequestTruthRefreshedEvent { repo, pullRequest, workItemIds }`
- Dispatch `WorkItemMergedEvent` from the two places a work item
  enters `merged_pr`:
  1. `GitHubCacheScheduler` after `hsm.dispatch(gh.pr_merged)` succeeds
  2. `PullRequestService.syncMergedPullRequest` after the same
- Dispatch `RunCompletedEvent` from `ExecutionService.executeRun`
  after the `status: "completed"` update (the last lines of the
  coroutine).
- Dispatch `PullRequestTruthRefreshedEvent` from `GitHubService` in
  place of the `pullRequestTruthRefresher` callback. Delete the
  callback registration API.
- Add a subscriber handler in `PullRequestService` that implements
  the old `refreshPullRequestTruth` behaviour as an
  `@EventsHandler(PullRequestTruthRefreshedEvent)`.
- Add zero other subscribers for now. The events exist but nothing
  else listens. The next time someone adds a cross-context reaction
  (e.g. Phase 8's drift report on RunCompleted), they subscribe.
- Remove the `registerPullRequestTruthRefresher` method from
  `GitHubService` and the corresponding call from
  `ExecutionService`'s constructor.

**Out:**

- **No** event for state transitions generally. The HSM already emits
  a structured `work_item_state_changed` envelope over the
  `/api/graph/stream` SSE channel for the UI. That's a presentation
  concern; it doesn't need to live on the CQRS event bus.
- **No** event-driven replacement for `HsmActionHandlers.closeGhIssue`
  or `.runArchiver`. Those are synchronous, load-bearing, and must
  not continue if they fail — exactly the case where events are
  wrong.
- **No** replacement for direct service calls inside `executeRun` or
  inside the disposition service. Internal-to-a-module calls stay
  direct.
- **No** new command dispatches. Commands were Phase 2's job.
- **No** change to the SCXML chart or HSM action registration.

## File changes

### 1. `src/modules/execution/events/` (new directory)

Three files, one per event class:

```typescript
// work-item-merged.event.ts
import type { IEvent } from "@nestjs/cqrs";

export class WorkItemMergedEvent implements IEvent {
  constructor(
    public readonly workItemId: string,
    public readonly pullRequest: {
      number: number;
      url: string;
      title: string;
      merged_at: string;
      merge_commit_sha: string | null;
    },
    public readonly source: "scheduler" | "sync_merged_api",
  ) {}
}
```

```typescript
// run-completed.event.ts
export class RunCompletedEvent implements IEvent {
  constructor(
    public readonly runId: string,
    public readonly workItemId: string,
    public readonly changedFiles: string[],
    public readonly resultSummary: string,
    public readonly pullRequest?: ExecutionPullRequestRecord,
  ) {}
}
```

```typescript
// pull-request-truth-refreshed.event.ts
export class PullRequestTruthRefreshedEvent implements IEvent {
  constructor(
    public readonly repo: string,
    public readonly pullRequest: GitHubPullRequestDetails,
    public readonly workItemIds: string[],
  ) {}
}
```

### 2. `src/modules/execution/pull-request.service.ts`

Add `@EventsHandler(PullRequestTruthRefreshedEvent)` subscriber:

```typescript
@EventsHandler(PullRequestTruthRefreshedEvent)
export class PullRequestTruthRefreshedHandler
  implements IEventHandler<PullRequestTruthRefreshedEvent>
{
  constructor(
    @Inject(PullRequestService) private readonly pullRequests: PullRequestService,
  ) {}

  handle(event: PullRequestTruthRefreshedEvent): void {
    this.pullRequests.refreshRunsForPullRequest(event.pullRequest, {
      work_item_ids: event.workItemIds,
    });
  }
}
```

Rename the internal method from `refreshPullRequestTruth` to
`refreshRunsForPullRequest` so the intent is explicit: it's updating
the run store, not reconciling the PR.

### 3. `src/modules/github/github.service.ts`

Delete:
- The `registerPullRequestTruthRefresher` method
- The `pullRequestTruthRefresher` private field
- The `this.pullRequestTruthRefresher?.(pullRequest, ...)` call at the
  bottom of `withPullRequestReconciliation`

Replace with:
```typescript
// At the bottom of withPullRequestReconciliation:
this.eventBus.publish(new PullRequestTruthRefreshedEvent(
  pullRequest.repo,
  pullRequest,
  nextWorkItems.map((wi) => wi.id),
));
```

Inject `EventBus` in the constructor. No module import change —
`CqrsModule` is global after Phase 0.

### 4. `src/modules/execution/pull-request.service.ts` → `syncMergedPullRequest`

After the successful HSM dispatch + work item update, publish:

```typescript
this.eventBus.publish(new WorkItemMergedEvent(
  workItem.id,
  {
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
    merged_at: pullRequest.merged_at!,
    merge_commit_sha: pullRequest.merge_commit_sha ?? null,
  },
  "sync_merged_api",
));
```

### 5. `src/modules/execution/github-cache-scheduler.service.ts`

In `sweepRepo`, after `hsm.dispatch({ type: "gh.pr_merged", ... })`
succeeds and `mutation_applied === true`, publish
`WorkItemMergedEvent` with `source: "scheduler"`.

### 6. `src/modules/execution/execution.service.ts` (orchestrator)

At the end of `executeRun`, after the final `updateRun(status: "completed", ...)`:

```typescript
this.eventBus.publish(new RunCompletedEvent(
  run.run_id,
  run.work_item_id,
  changedFiles,
  assistantText,
  run.pull_request,
));
```

Inject `EventBus` in the constructor.

### 7. `src/modules/execution/execution.service.ts` constructor

Delete `this.github.registerPullRequestTruthRefresher(...)` (it was
moved to `PullRequestService` anyway in Phase 4, but the registration
is gone now).

## ForwardRef impact

Removing the callback handshake between `GitHubService` and
`ExecutionService` does not directly remove a module-level forwardRef
— `ExecutionModule → GitHubModule` is still needed because
`ExecutionService` injects `GitHubService` for reads. But it lets us
rethink one edge: `ExecutionModule → forwardRef(PlansModule)` currently
exists because `ExecutionService.deleteWorkItem` needs
`PlansService.deletePlanArtifacts`. After Phase 3, `deleteWorkItem`
lives on `RunDispositionService`. If we event-drive the plan cleanup
by publishing `WorkItemDeletedEvent` and making a `PlansService`
handler subscribe, `RunDispositionService` no longer injects
`PlansService` directly.

That's a small additional scope add for Phase 5 — one more event
pair (`WorkItemDeletedEvent` + subscriber) that removes one more
forwardRef. Worth doing inside this phase because it's the same
pattern and the same testing story. **Net: −1** (8 → 7).

## Tests

**New:**
- `src/modules/execution/events/__tests__/` — one test per event
  dispatcher: publish happens exactly once after the primary action
  succeeds, does not publish when the primary action fails, payload
  fields are correct.
- `PullRequestTruthRefreshedHandler` test — construct with stub
  service, call `handle(event)`, assert delegate was called.

**Modified:**
- `github-cache-scheduler.test.ts` — assert `eventBus.publish` was
  called exactly once per applied dispatch.
- `execution-rehydrate.test.ts` — rewires the callback assertion to
  use `EventBus` instead of `registerPullRequestTruthRefresher`.

## Acceptance criteria

- [ ] Three new event classes exist under `src/modules/execution/events/`
- [ ] `GitHubService.registerPullRequestTruthRefresher` no longer
      exists (verify by grep)
- [ ] `ExecutionService` constructor contains no
      `registerPullRequestTruthRefresher` call
- [ ] `WorkItemMergedEvent` is dispatched from exactly two sites
      (scheduler + sync API)
- [ ] `RunCompletedEvent` is dispatched from exactly one site
      (`executeRun` completion)
- [ ] `PullRequestTruthRefreshedEvent` is dispatched from
      `withPullRequestReconciliation`
- [ ] `PullRequestTruthRefreshedHandler` is registered as a CQRS
      event handler (verify by `@EventsHandler` decorator + module
      providers)
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` sums to **7**
- [ ] `npm test` passes; existing behaviour preserved

## Known remaining drift

- `@nestjs/cqrs`'s `EventBus` is synchronous in-process and swallows
  subscriber errors. Every dispatch site in this phase is structured
  as "publish after the primary action completed successfully" —
  i.e. the event is a notification of a finished fact, not a step in
  the transaction. A subscriber that throws is logged and ignored.
  That's intentional for the cases picked here. If a future
  subscriber is load-bearing, the right fix is a durable outbox
  pattern, not retrofitting the existing events.
- The HSM's own `work_item_state_changed` SSE envelope (on
  `/api/graph/stream`) is still emitted directly from
  `WorkItemHsmService.dispatch` via `GraphEventsService`. This is a
  presentation concern and stays where it is.
- `ExecutionService` still injects eight collaborators (down one from
  Phase 4 because the callback registration dependency is gone).

## Next

[Phase 6](phase-6-platform-module.md) moves `SQLiteService` out of
GraphModule into a new `PlatformModule`, and moves `GitHubBatchCache`
+ `GitHubCacheScheduler` out of ExecutionModule into GitHubModule.
Combined effect: **−3 forwardRefs**, down to **4**.
