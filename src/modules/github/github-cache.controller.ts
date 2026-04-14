import { Controller, Inject, Post, Query } from "@nestjs/common";
import { GitHubCacheScheduler, type SweepResult } from "./github-cache-scheduler.service.js";

/**
 * studio-197: on-demand cache refresh endpoint.
 *
 * `POST /api/github-cache/refresh` triggers the same sweep logic as
 * the scheduler's @Cron tick: invalidate cache, refetch from GitHub,
 * dispatch HSM events for any state advances. Optionally scoped to a
 * single repo via `?repo=owner/repo`.
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
