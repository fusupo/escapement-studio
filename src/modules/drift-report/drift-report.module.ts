import { Module } from "@nestjs/common";
import { ExecutionModule } from "../execution/execution.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { DriftReportController } from "./drift-report.controller.js";
import { DriftReportService } from "./drift-report.service.js";

/**
 * Phase 8b (#238): renamed from `ReconciliationModule`. The service is
 * a drift-report generator (predicted vs. actual files) — unrelated to
 * the actual reconciliation work in `WorkItemReconcilerService` inside
 * ExecutionModule. The HTTP URL `/api/reconciliation` and the planner
 * tool name `reconciliation_query` are intentionally preserved.
 *
 * `ExecutionModule` import stays because `DriftReportService` injects
 * `RunStore`, which lives in `ExecutionModule`. Extracting `RunStore`
 * into its own module is a separate architectural decision deferred
 * to a future phase.
 */
@Module({
  imports: [GraphModule, ExecutionModule],
  controllers: [DriftReportController],
  providers: [DriftReportService],
  exports: [DriftReportService],
})
export class DriftReportModule {}
