import type { IEvent } from "@nestjs/cqrs";

/**
 * Phase 5 (#225): fires after `RunDispositionService.deleteWorkItem`
 * has finished the destructive removal of a work item from the
 * graph store. The handler (`WorkItemDeletedHandler` in PlansModule)
 * calls `PlansService.deletePlanArtifacts` to clean up the plan
 * directory.
 *
 * **This event is load-bearing for the forwardRef removal.** Before
 * Phase 5, `RunDispositionService` directly injected `PlansService`
 * via `forwardRef(() => PlansService)` because `execution.module`
 * imports `forwardRef(() => PlansModule)`. Routing the plan cleanup
 * through an event handler removes that injection and lets the
 * forwardRef count drop 8 → 7.
 *
 * EventBus is synchronous and swallows subscriber errors — but
 * plan-directory cleanup is non-fatal (the artifact dir already has
 * a missing-directory guard in `deletePlanArtifacts`), so a silent
 * failure here just means the plan dir sticks around on disk and
 * a future reconcile pass can sweep it. Acceptable.
 */
export class WorkItemDeletedEvent implements IEvent {
  constructor(
    public readonly workItemId: string,
  ) {}
}
