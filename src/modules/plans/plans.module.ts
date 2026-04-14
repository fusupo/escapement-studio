import { forwardRef, Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { PreparePlanHandler } from "./application/commands/prepare-plan.handler.js";
import { ReopenPlanHandler } from "./application/commands/reopen-plan.handler.js";
import { PlanDrafterService } from "./plan-drafter.service.js";
import { PlansController } from "./plans.controller.js";
import { PlansService } from "./plans.service.js";
import { WorkItemDeletedHandler } from "./work-item-deleted.handler.js";

/**
 * ADR 014 step 4 — plan preparation module.
 *
 * Depends on GraphModule (for WorkItemsService) and GitHubModule (for
 * StudioIssueTemplateService). One-directional — nothing else imports
 * PlansModule, so no forwardRef cycles.
 */
@Module({
  imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), forwardRef(() => SettingsModule)],
  controllers: [PlansController],
  providers: [
    PlansService,
    PlanDrafterService,
    PreparePlanHandler,
    ReopenPlanHandler,
    WorkItemDeletedHandler,
  ],
  exports: [PlansService, PlanDrafterService],
})
export class PlansModule {}
