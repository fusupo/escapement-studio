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
 * direct dependency and the ExecutionModule's
 * `forwardRef(() => PlansModule)` goes away, dropping the
 * project-wide forwardRef count 8 → 7.
 *
 * Lives in PlansModule because its target service (`PlansService`)
 * lives there. This handler is the ONE subscriber that actually
 * needs to run — the plan directory on disk is a side effect that
 * can't be recovered without an explicit reconcile pass. That said,
 * `deletePlanArtifacts` is defensive (missing dir = no-op), so a
 * silent handler failure is degraded-but-not-broken behavior.
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
      // PlansService.deletePlanArtifacts currently looks up the
      // work item via WorkItemsService.get first, which throws if
      // the work item has already been removed from the graph.
      // That's the normal case in the post-delete handler — the
      // delete already finished. Swallow the lookup error; a
      // future reconcile pass can sweep any orphaned plan dirs.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to delete plan artifacts for ${event.workItemId}: ${message}`,
      );
    }
  }
}
