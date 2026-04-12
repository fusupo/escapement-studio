import { forwardRef, Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ExecutionController } from "./execution.controller.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";
import { ExecutionService } from "./execution.service.js";
import { WorkItemReconcilerController } from "./work-item-reconciler.controller.js";
import { WorkItemReconcilerService } from "./work-item-reconciler.service.js";

@Module({
  imports: [forwardRef(() => GraphModule), GitHubModule, SettingsModule],
  controllers: [ExecutionController, WorkItemReconcilerController],
  providers: [ExecutionService, GitHubBatchCache, WorkItemReconcilerService],
  exports: [ExecutionService, GitHubBatchCache, WorkItemReconcilerService],
})
export class ExecutionModule {}
