import { Module } from "@nestjs/common";
import { GitHubModule } from "./modules/github/github.module.js";
import { GraphModule } from "./modules/graph/graph.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { PlanningModule } from "./modules/planning/planning.module.js";

@Module({
  imports: [GraphModule, HealthModule, GitHubModule, PlanningModule],
})
export class AppModule {}
