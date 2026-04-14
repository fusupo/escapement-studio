import type { IEvent } from "@nestjs/cqrs";

/**
 * Phase 5 (#225): fires after a work item successfully transitions into
 * `merged_pr` — i.e. the HSM dispatched `gh.pr_merged` and
 * `mutation_applied` came back `true`. Dispatched from two sites:
 *
 *   1. `GitHubCacheScheduler.sweepRepo` — the background reconciler
 *      that polls GitHub and drives state transitions.
 *   2. `PullRequestService.syncMergedPullRequest` — the `POST
 *      /api/execution/post-merge-sync` HTTP entry point.
 *
 * No subscribers land in Phase 5. The event exists so future
 * consumers (drift reports, notifications, the Phase 8 reconciliation
 * pass) can subscribe without adding a new cross-module import.
 *
 * EventBus is synchronous in-process and swallows subscriber errors,
 * so every dispatcher must `eventBus.publish` only **after** the
 * primary action (HSM dispatch + work-item update) has fully
 * committed. Subscriber failures don't roll anything back.
 */
export class WorkItemMergedEvent implements IEvent {
  constructor(
    public readonly workItemId: string,
    public readonly pullRequest: {
      number: number;
      url: string;
      title: string;
      merged_at: string;
      merge_commit_sha: string | null;
    },
    public readonly source: "scheduler" | "sync_merged_api",
  ) {}
}
