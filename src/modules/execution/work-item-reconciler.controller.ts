import { Controller, Get, Inject, Query } from "@nestjs/common";
import { WorkItemReconcilerService } from "./work-item-reconciler.service.js";
import type { ReconciledWorkItem } from "./work-item-reconciler.types.js";

/**
 * Issue #176: exposes the reconciled work-item view.
 *
 * Lives under `src/modules/execution/` rather than
 * `src/modules/graph/work-items.controller.ts` so the reconciler can pull
 * execution-layer dependencies (run-disk-store, ExecutionService wiring)
 * without dragging them into the graph module. The URL path is still
 * `/api/work-items/reconciled` per the issue spec.
 */
@Controller("api/work-items")
export class WorkItemReconcilerController {
  constructor(
    @Inject(WorkItemReconcilerService) private readonly reconciler: WorkItemReconcilerService,
  ) {}

  @Get("reconciled")
  async getReconciled(@Query("work_item_id") workItemId?: string): Promise<ReconciledWorkItem[]> {
    return this.reconciler.reconcile(workItemId?.trim() ? { work_item_id: workItemId.trim() } : {});
  }
}
