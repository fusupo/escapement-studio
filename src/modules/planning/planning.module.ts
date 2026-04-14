import { Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ContextService } from "./context.service.js";
import { MemoryService } from "./memory.service.js";
import { PlanningController } from "./planning.controller.js";
import { PlanningService } from "./planning.service.js";
import { ProposalStateService } from "./proposal-state.service.js";
import { SubAgentService } from "./sub-agent.service.js";
import { DriftReportModule } from "../drift-report/drift-report.module.js";

@Module({
  imports: [GraphModule, GitHubModule, DriftReportModule, SettingsModule],
  controllers: [PlanningController],
  providers: [PlanningService, ContextService, MemoryService, ProposalStateService, SubAgentService],
  exports: [PlanningService, ContextService, MemoryService, ProposalStateService, SubAgentService],
})
export class PlanningModule {}
