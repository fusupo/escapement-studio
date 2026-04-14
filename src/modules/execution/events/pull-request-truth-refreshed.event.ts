import type { IEvent } from "@nestjs/cqrs";
import type { GitHubPullRequestDetails } from "../../github/github.service.js";

/**
 * Phase 5 (#225): fires from `GitHubService.withPullRequestReconciliation`
 * after the reconciler has walked the affected work items and
 * updated them in the graph store. Replaces the bespoke
 * `registerPullRequestTruthRefresher` callback handshake between
 * `GitHubService` and `PullRequestService` with a proper event.
 *
 * The subscriber (`PullRequestTruthRefreshedHandler`) delegates to
 * `PullRequestService.refreshRunsForPullRequest` so the execution
 * run store learns about the PR truth update. Before Phase 5 that
 * was a one-subscriber push via a private callback field.
 */
export class PullRequestTruthRefreshedEvent implements IEvent {
  constructor(
    public readonly pullRequest: GitHubPullRequestDetails,
    public readonly workItemIds: string[],
  ) {}
}
