import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { PlatformModule } from "./platform/platform.module.js";
import { ExecutionModule } from "./modules/execution/execution.module.js";
import { GitHubModule } from "./modules/github/github.module.js";
import { GraphModule } from "./modules/graph/graph.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { PlanningModule } from "./modules/planning/planning.module.js";
import { PlansModule } from "./modules/plans/plans.module.js";
import { DriftReportModule } from "./modules/drift-report/drift-report.module.js";
import { SettingsModule } from "./modules/settings/settings.module.js";

@Module({
  imports: [
    PlatformModule,
    ScheduleModule.forRoot(),
    ExecutionModule,
    GraphModule,
    HealthModule,
    GitHubModule,
    PlanningModule,
    PlansModule,
    DriftReportModule,
    SettingsModule,
  ],
})
export class AppModule {}
