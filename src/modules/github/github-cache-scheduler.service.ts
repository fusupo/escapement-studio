import { Inject, Injectable, Logger } from "@nestjs/common";
import { EventBus } from "@nestjs/cqrs";
import { Cron, CronExpression } from "@nestjs/schedule";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import { GitHubRepoTruthRefreshedEvent, normalizeGitHubRepo } from "./events/github-repo-truth-refreshed.event.js";
import { WorkItemMergedEvent } from "../execution/events/work-item-merged.event.js";
import { GitHubBatchCache, type CachedPullRequest, type CachedIssue } from "./github-batch-cache.service.js";
import { GitHubItemLookup } from "./github-item-lookup.service.js";

/**
 * studio-197: periodic cache refresh + auto-dispatch of `gh.*` HSM events.
 *
 * Runs every 60s. For each tracked repo: look up the GitHub state of
 * the work items that are waiting on GitHub (#292: only those, not the
 * whole repo), then dispatch HSM events where that state has advanced
 * beyond the work item's local state. The full PR and issue listings in
 * the batch cache are no longer refreshed here; readers that need them
 * (reconciliation) fetch them when the cache is older than its TTL.
 *
 * The same sweep logic is exposed via `sweep(repo?)` so the
 * `POST /api/github-cache/refresh` endpoint can trigger it on demand
 * (the Refresh button, and the web UI when its tab regains focus, #291).
 * Overlapping sweeps of one repo share a single run.
 */
@Injectable()
export class GitHubCacheScheduler {
  private readonly logger = new Logger(GitHubCacheScheduler.name);
  /** Sweeps in flight, by repo, so overlapping triggers share one run. */
  private readonly inFlight = new Map<string, Promise<SweepResult>>();

  constructor(
    @Inject(GitHubBatchCache) private readonly cache: GitHubBatchCache,
    @Inject(GitHubItemLookup) private readonly lookup: GitHubItemLookup,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(EventBus) private readonly eventBus: EventBus,
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
   * Run a GitHub-refresh + HSM-dispatch sweep. If `repo` is provided,
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
        const result = await this.sweepRepoOnce(r);
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

  /**
   * Join the sweep already running for `repo`, or start one. The timer
   * tick, the Refresh button and tab-focus refreshes from any number of
   * browser tabs can overlap; running them in parallel would refetch the
   * same lists and dispatch the same `gh.*` events twice. A joiner may get
   * state fetched just before its own trigger; the next sweep corrects it.
   */
  private sweepRepoOnce(repo: string): Promise<SweepResult> {
    const running = this.inFlight.get(repo);
    if (running) return running;
    const started = this.sweepRepo(repo).finally(() => {
      this.inFlight.delete(repo);
    });
    this.inFlight.set(repo, started);
    return started;
  }

  private async sweepRepo(repo: string): Promise<SweepResult> {
    const { prs, issues, complete } = await this.fetchTruth(repo, this.waitingItems(repo));
    const identity = normalizeGitHubRepo(repo);
    if (identity && complete) this.eventBus.publish(new GitHubRepoTruthRefreshedEvent(identity, Date.now()));

    // Read the items again: their state may have moved while gh ran.
    const workItems = this.waitingItems(repo);

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

            // Phase 5 (#225): publish WorkItemMergedEvent when the
            // sweep successfully transitions a work item into
            // merged_pr. Fired after the HSM dispatch commits so
            // subscribers see the post-transition state.
            if (event.type === "gh.pr_merged") {
              const pr = event.pull_request as Record<string, unknown> | undefined;
              const prNumber = typeof pr?.number === "number" ? pr.number : null;
              const prUrl = typeof pr?.url === "string" ? pr.url : null;
              const prTitle = typeof pr?.title === "string" ? pr.title : null;
              const mergedAt = typeof pr?.merged_at === "string" ? pr.merged_at : null;
              if (prNumber != null && prUrl && prTitle && mergedAt) {
                this.eventBus.publish(
                  new WorkItemMergedEvent(
                    workItem.id,
                    {
                      number: prNumber,
                      url: prUrl,
                      title: prTitle,
                      merged_at: mergedAt,
                      merge_commit_sha: null,
                    },
                    "scheduler",
                  ),
                );
              }
            }
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

  /** Work items in `repo` whose next transition depends on GitHub. */
  private waitingItems(repo: string): WorkItemRecord[] {
    return this.workItemsService.list({}).filter(
      (w) => w.repo === repo && DISPATCH_SOURCE_STATES.has(w.state),
    );
  }

  /**
   * Fetch the GitHub state the waiting items depend on (#292): the pull
   * requests of each in-progress or open-PR item's branch and the issue
   * of each merged item, one short `gh` call per distinct branch or
   * issue, written through to the batch cache. Nothing waiting means no
   * calls. A failed lookup is logged and leaves its item unchecked until
   * the next sweep; `complete` is false so the sweep does not announce
   * refreshed truth.
   *
   * Past `MAX_TARGETED_LOOKUPS` the two full listings are cheaper, so
   * the sweep falls back to invalidating and re-listing the repo; a
   * listing failure rejects and fails the repo's sweep.
   */
  private async fetchTruth(repo: string, waiting: WorkItemRecord[]): Promise<GitHubTruth> {
    const branches = new Set<string>();
    const issueNumbers = new Set<number>();
    for (const workItem of waiting) {
      const state = this.normalizeState(workItem.state);
      const branch = workItem.branch?.trim();
      if ((state === "in_progress" || state === "open_pr") && branch) branches.add(branch);
      if (state === "merged_pr" && typeof workItem.issue_number === "number") issueNumbers.add(workItem.issue_number);
    }

    if (branches.size + issueNumbers.size > MAX_TARGETED_LOOKUPS) {
      this.cache.invalidate(repo);
      const prs = await this.cache.listPullRequests(repo);
      const issues = await this.cache.listIssues(repo);
      return { prs, issues, complete: true };
    }

    const prs = new Map<number, CachedPullRequest>();
    const issues = new Map<number, CachedIssue>();
    let complete = true;
    const attempt = async (what: string, lookup: () => Promise<void>) => {
      try {
        await lookup();
      } catch (error) {
        complete = false;
        this.logger.warn(`Sweep lookup of ${what} failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Started together; the shared gh runner limits how many run at once.
    await Promise.all([
      ...Array.from(branches, (branch) => attempt(`branch ${branch}`, async () => {
        for (const pr of await this.lookup.pullRequestsForBranch(repo, branch)) {
          prs.set(pr.number, pr);
          this.cache.upsertPullRequest(repo, pr);
        }
      })),
      ...Array.from(issueNumbers, (issueNumber) => attempt(`issue #${issueNumber}`, async () => {
        const issue = await this.lookup.issue(repo, issueNumber);
        issues.set(issue.number, issue);
        this.cache.upsertIssue(repo, issue);
      })),
    ]);
    return { prs, issues, complete };
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
  /** Pull requests looked at: those of the waiting items' branches, or the whole listing. */
  prs: number;
  /** Issues looked at, likewise. */
  issues: number;
  dispatched: number;
}

interface GitHubTruth {
  prs: Map<number, CachedPullRequest>;
  issues: Map<number, CachedIssue>;
  /** False when a lookup failed, so some waiting item went unchecked. */
  complete: boolean;
}

/** Distinct branch and issue lookups per repo above which the full listings are used. */
const MAX_TARGETED_LOOKUPS = 8;

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
