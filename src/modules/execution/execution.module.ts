import { forwardRef, Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ArchiveAndCloseMergedPullRequestHandler } from "./application/commands/archive-and-close-merged-pull-request.handler.js";
import { CancelWorkItemHandler } from "./application/commands/cancel-work-item.handler.js";
import { CloseMergedPullRequestHandler } from "./application/commands/close-merged-pull-request.handler.js";
import { DeleteWorkItemHandler } from "./application/commands/delete-work-item.handler.js";
import { TransitionInProgressToDraftingHandler } from "./application/commands/transition-in-progress-to-drafting.handler.js";
import { TransitionInProgressToReadyHandler } from "./application/commands/transition-in-progress-to-ready.handler.js";
import { PullRequestTruthRefreshedHandler } from "./events/pull-request-truth-refreshed.handler.js";
import { ExecutionController } from "./execution.controller.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";
import { GitHubCacheController } from "./github-cache.controller.js";
import { GitHubCacheScheduler } from "./github-cache-scheduler.service.js";
import { ExecutionService } from "./execution.service.js";
import { HsmActionHandlers } from "./hsm-action-handlers.js";
import { PullRequestService } from "./pull-request.service.js";
import { RunDispositionService } from "./run-disposition.service.js";
import { RunInteractionService } from "./run-interaction.service.js";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService } from "./scratchpad.service.js";
import { WorkItemReconcilerController } from "./work-item-reconciler.controller.js";
import { WorkItemReconcilerService } from "./work-item-reconciler.service.js";
import { WorktreeService } from "./worktree.service.js";

@Module({
  imports: [forwardRef(() => GraphModule), forwardRef(() => GitHubModule), SettingsModule],
  controllers: [ExecutionController, GitHubCacheController, WorkItemReconcilerController],
  providers: [
    ExecutionService,
    GitHubBatchCache,
    GitHubCacheScheduler,
    HsmActionHandlers,
    PullRequestService,
    RunDispositionService,
    RunInteractionService,
    RunStore,
    ScratchpadService,
    WorktreeService,
    WorkItemReconcilerService,
    CancelWorkItemHandler,
    DeleteWorkItemHandler,
    TransitionInProgressToReadyHandler,
    TransitionInProgressToDraftingHandler,
    CloseMergedPullRequestHandler,
    ArchiveAndCloseMergedPullRequestHandler,
    PullRequestTruthRefreshedHandler,
  ],
  exports: [
    ExecutionService,
    GitHubBatchCache,
    GitHubCacheScheduler,
    PullRequestService,
    RunDispositionService,
    RunInteractionService,
    RunStore,
    ScratchpadService,
    WorktreeService,
    WorkItemReconcilerService,
  ],
})
export class ExecutionModule {}
