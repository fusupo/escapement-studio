import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";
import { GitHubCacheController } from "./github-cache.controller.js";
import { GitHubCacheScheduler } from "./github-cache-scheduler.service.js";
import { GitHubController } from "./github.controller.js";
import { GitHubIssueBodySyncService } from "./github-issue-body-sync.service.js";
import { GitHubService } from "./github.service.js";
import { StudioIssueTemplateService } from "./studio-issue-template.service.js";

/**
 * Phase 6b (#236): `GitHubBatchCache`, `GitHubCacheScheduler`, and
 * `GitHubCacheController` moved here from `ExecutionModule`. Caching
 * external GitHub state is a GitHub concern, not an execution concern.
 * Consolidating everything that talks to the `gh` CLI in one module
 * lets future consumers (drift reports, planner tools, notifications)
 * import `GitHubModule` instead of reaching into execution internals.
 *
 * `GitHubBatchCache` + `GitHubCacheScheduler` are exported so the
 * existing execution sub-services (RunDispositionService,
 * PullRequestService, WorkItemReconcilerService) can still inject them
 * via the existing ExecutionModule → GitHubModule forward-referenced
 * edge.
 */
@Module({
  imports: [GraphModule],
  controllers: [GitHubController, GitHubCacheController],
  providers: [
    GitHubService,
    GitHubIssueBodySyncService,
    StudioIssueTemplateService,
    GitHubBatchCache,
    GitHubCacheScheduler,
  ],
  exports: [
    GitHubService,
    GitHubIssueBodySyncService,
    StudioIssueTemplateService,
    GitHubBatchCache,
    GitHubCacheScheduler,
  ],
})
export class GitHubModule {}
