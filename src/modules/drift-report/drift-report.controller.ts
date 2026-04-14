import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DriftReportService } from "./drift-report.service.js";

// FIXME(url-rename): `api/reconciliation` is preserved post Phase 8b
// (#238) for frontend (ReconciliationPanel.svelte / web/src/lib/api.js)
// and planner-tool (`reconciliation_query`) stability. Renaming the
// URL is a separate breaking change with FE coordination.
@Controller("api/reconciliation")
export class DriftReportController {
  constructor(@Inject(DriftReportService) private readonly driftReportService: DriftReportService) {}

  @Get("reports")
  listReports(@Query("work_item_id") workItemId?: string) {
    return workItemId
      ? this.driftReportService.getReport(workItemId)
      : this.driftReportService.listReports();
  }
}
