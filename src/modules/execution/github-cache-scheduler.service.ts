import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import { GitHubBatchCache, type CachedPullRequest, type CachedIssue } from "./github-batch-cache.service.js";

/**
 * studio-197: periodic cache refresh + auto-dispatch of `gh.*` HSM events.
 *
 * Runs every 60s. For each tracked repo: invalidate the batch cache,
 * refetch PR + issue state from GitHub, then iterate reconcilable work
 * items and dispatch HSM events where the cached GH state has advanced
 * beyond the work item's local state.
 *
 * The same sweep logic is exposed via `sweep(repo?)` so the
 * `POST /api/github-cache/refresh` endpoint can trigger it on demand.
 */
@Injectable()
export class GitHubCacheScheduler {
  private readonly logger = new Logger(GitHubCacheScheduler.name);

  constructor(
    @Inject(GitHubBatchCache) private readonly cache: GitHubBatchCache,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    try {
      const results = await this.sweep();
      if (results.length > 0) {
        const totalDispatched = results.reduce((sum, r) => sum + r.dispatched, 0);
        this.logger.log(
          `Cache sweep: ${results.length} repo(s), ${totalDispatched} HSM event(s) dispatched`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Cache sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Run a full cache-refresh + HSM-dispatch sweep. If `repo` is provided,
   * only that repo is refreshed; otherwise all tracked repos are swept.
   *
   * Returns per-repo results for the response envelope.
   */
  async sweep(repo?: string): Promise<SweepResult[]> {
    const repos = repo ? [repo] : this.discoverTrackedRepos();
    if (repos.length === 0) {
      return [];
    }

    const results: SweepResult[] = [];
    for (const r of repos) {
      try {
        const result = await this.sweepRepo(r);
        results.push(result);
      } catch (error) {
        this.logger.warn(
          `Sweep failed for ${r}: ${error instanceof Error ? error.message : String(error)}`,
        );
        results.push({ repo: r, prs: 0, issues: 0, dispatched: 0 });
      }
    }
    return results;
  }

  private async sweepRepo(repo: string): Promise<SweepResult> {
    // Invalidate + refetch
    this.cache.invalidate(repo);
    const [prs, issues] = await Promise.all([
      this.cache.listPullRequests(repo),
      this.cache.listIssues(repo),
    ]);

    // Dispatch HSM events for any state advances
    const workItems = this.workItemsService.list({}).filter(
      (w) => w.repo === repo && DISPATCH_SOURCE_STATES.has(w.state),
    );

    let dispatched = 0;
    for (const workItem of workItems) {
      const events = this.detectStateAdvances(workItem, prs, issues);
      for (const event of events) {
        try {
          const result = await this.hsmService.dispatch(workItem.id, event);
          if (result.mutation_applied) {
            dispatched++;
            this.logger.log(
              `Sweep dispatched ${event.type} for ${workItem.id}: ${result.prev_state} → ${result.next_state}`,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Sweep dispatch ${event.type} failed for ${workItem.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return { repo, prs: prs.size, issues: issues.size, dispatched };
  }

  /**
   * Compare a work item's local state against the cached GH state and
   * return any HSM events that should fire. Each event is only returned
   * when the work item is in the expected source state for that transition.
   */
  private detectStateAdvances(
    workItem: WorkItemRecord,
    prs: Map<number, CachedPullRequest>,
    issues: Map<number, CachedIssue>,
  ): import("../graph/types.js").WorkItemHsmEvent[] {
    const events: import("../graph/types.js").WorkItemHsmEvent[] = [];
    const state = this.normalizeState(workItem.state);
    const branch = workItem.branch?.trim();

    // in_progress → open_pr: a PR exists for the work item's branch
    if (state === "in_progress" && branch) {
      for (const pr of prs.values()) {
        if (pr.head_ref === branch) {
          events.push({ type: "gh.pr_opened", pull_request: pr as unknown as Record<string, unknown> });
          break;
        }
      }
    }

    // open_pr → merged_pr: the PR for this branch is MERGED
    if (state === "open_pr" && branch) {
      for (const pr of prs.values()) {
        if (pr.head_ref === branch && pr.state === "MERGED") {
          events.push({ type: "gh.pr_merged", pull_request: pr as unknown as Record<string, unknown> });
          break;
        }
      }
    }

    // merged_pr → closed: the linked issue is closed
    if (state === "merged_pr" && typeof workItem.issue_number === "number") {
      const issue = issues.get(workItem.issue_number);
      if (issue && issue.state === "closed") {
        events.push({ type: "gh.issue_closed", issue: issue as unknown as Record<string, unknown> });
      }
    }

    return events;
  }

  /**
   * Discover all distinct repo values from tracked work items. Used when
   * no specific repo is requested (timer tick sweeps everything).
   */
  private discoverTrackedRepos(): string[] {
    const workItems = this.workItemsService.list({});
    const repos = new Set<string>();
    for (const w of workItems) {
      if (w.repo) repos.add(w.repo);
    }
    return Array.from(repos);
  }

  /**
   * Normalize dotted pre_pr.X states to their leaf for comparison.
   */
  private normalizeState(state: WorkItemState): string {
    return state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
  }
}

export interface SweepResult {
  repo: string;
  prs: number;
  issues: number;
  dispatched: number;
}

/**
 * Work item states that can produce gh.* events during a sweep.
 * Only items in these states are worth checking against cached GH truth.
 */
const DISPATCH_SOURCE_STATES: ReadonlySet<WorkItemState> = new Set([
  "in_progress",
  "pre_pr.in_progress",
  "open_pr",
  "merged_pr",
]);
