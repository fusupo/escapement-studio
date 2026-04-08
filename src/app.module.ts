import { Module } from "@nestjs/common";
import { ExecutionModule } from "./modules/execution/execution.module.js";
import { GitHubModule } from "./modules/github/github.module.js";
import { GraphModule } from "./modules/graph/graph.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { PlanningModule } from "./modules/planning/planning.module.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation.module.js";
import { SettingsModule } from "./modules/settings/settings.module.js";

@Module({
  imports: [ExecutionModule, GraphModule, HealthModule, GitHubModule, PlanningModule, ReconciliationModule, SettingsModule],
})
export class AppModule {}
