import { Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { PlanDrafterService } from "./plan-drafter.service.js";
import { PlansController } from "./plans.controller.js";
import { PlansService } from "./plans.service.js";

/**
 * ADR 014 step 4 — plan preparation module.
 *
 * Depends on GraphModule (for WorkItemsService) and GitHubModule (for
 * StudioIssueTemplateService). One-directional — nothing else imports
 * PlansModule, so no forwardRef cycles.
 */
@Module({
  imports: [GraphModule, GitHubModule],
  controllers: [PlansController],
  providers: [PlansService, PlanDrafterService],
  exports: [PlansService, PlanDrafterService],
})
export class PlansModule {}
