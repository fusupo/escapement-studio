import { Inject, Logger } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { WorkItemDeletedEvent } from "../execution/events/work-item-deleted.event.js";
import { PlansService } from "./plans.service.js";

/**
 * Phase 5 (#225): subscriber for `WorkItemDeletedEvent`. Cleans up
 * the plan artifact directory for the deleted work item.
 *
 * Before Phase 5, `RunDispositionService.deleteWorkItem` called
 * `PlansService.deletePlanArtifacts` directly via a
 * `forwardRef(() => PlansService)` injection. Routing the cleanup
 * through an event handler lets RunDispositionService drop the
 * direct dependency and the `ExecutionModule → forwardRef(PlansModule)`
 * edge goes away, dropping the project-wide forwardRef count 8 → 7.
 *
 * Lives in PlansModule because its target service (`PlansService`)
 * lives there. `deletePlanArtifacts` is idempotent and defensive
 * (missing dir = no-op) after Phase 5 — the caller doesn't need to
 * verify the work item still exists before dispatching the event.
 */
@EventsHandler(WorkItemDeletedEvent)
export class WorkItemDeletedHandler implements IEventHandler<WorkItemDeletedEvent> {
  private readonly logger = new Logger(WorkItemDeletedHandler.name);

  constructor(
    @Inject(PlansService) private readonly plansService: PlansService,
  ) {}

  handle(event: WorkItemDeletedEvent): void {
    try {
      this.plansService.deletePlanArtifacts(event.workItemId);
    } catch (error) {
      // EventBus swallows handler errors, but logging here gives
      // an explicit warning if plan-dir removal fails (e.g. fs
      // permissions). A future reconcile pass can sweep orphaned
      // plan dirs.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to delete plan artifacts for ${event.workItemId}: ${message}`,
      );
    }
  }
}
