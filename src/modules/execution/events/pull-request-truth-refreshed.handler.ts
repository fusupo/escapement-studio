import { Inject } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { PullRequestService } from "../pull-request.service.js";
import { PullRequestTruthRefreshedEvent } from "./pull-request-truth-refreshed.event.js";

/**
 * Phase 5 (#225): subscriber for `PullRequestTruthRefreshedEvent`.
 * Delegates to `PullRequestService.refreshRunsForPullRequest` so the
 * run store gets updated with the latest PR truth.
 *
 * Lives in ExecutionModule (not GitHubModule) because the handler's
 * target service is `PullRequestService`, which lives in
 * ExecutionModule. Registering the handler in GitHubModule would
 * force a GitHubModule → ExecutionModule import (circular). This
 * arrangement keeps handlers co-located with their targets.
 */
@EventsHandler(PullRequestTruthRefreshedEvent)
export class PullRequestTruthRefreshedHandler
  implements IEventHandler<PullRequestTruthRefreshedEvent>
{
  constructor(
    @Inject(PullRequestService) private readonly pullRequestService: PullRequestService,
  ) {}

  handle(event: PullRequestTruthRefreshedEvent): void {
    this.pullRequestService.refreshRunsForPullRequest(event.pullRequest, {
      work_item_ids: event.workItemIds,
    });
  }
}
