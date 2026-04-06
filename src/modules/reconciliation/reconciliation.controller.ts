import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ReconciliationService } from "./reconciliation.service.js";

@Controller("api/reconciliation")
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly reconciliationService: ReconciliationService) {}

  @Get("reports")
  listReports(@Query("work_item_id") workItemId?: string) {
    return workItemId
      ? this.reconciliationService.getReport(workItemId)
      : this.reconciliationService.listReports();
  }
}
