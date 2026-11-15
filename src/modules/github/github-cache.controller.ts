import { Controller, Inject, Post, Query } from "@nestjs/common";
import { GitHubCacheScheduler, type SweepResult } from "./github-cache-scheduler.service.js";

/**
 * studio-197: on-demand cache refresh endpoint.
 *
 * `POST /api/github-cache/refresh` triggers the same sweep logic as
 * the scheduler's @Cron tick: invalidate cache, refetch from GitHub,
 * dispatch HSM events for any state advances. Optionally scoped to a
 * single repo via `?repo=owner/repo`.
 *
 * Callers: the Execute tab's Refresh button, and the web UI whenever
 * its browser tab regains focus (#291, at most once per 10 s per tab).
 * A request that overlaps a running sweep of the same repo joins it.
 */
@Controller("api/github-cache")
export class GitHubCacheController {
  constructor(
    @Inject(GitHubCacheScheduler)
    private readonly scheduler: GitHubCacheScheduler,
  ) {}

  @Post("refresh")
  async refresh(@Query("repo") repo?: string): Promise<{
    refreshed: SweepResult[];
  }> {
    const refreshed = await this.scheduler.sweep(repo || undefined);
    return { refreshed };
  }
}
