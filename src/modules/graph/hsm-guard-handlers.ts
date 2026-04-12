import { Inject, Injectable } from "@nestjs/common";
import { GitHubBatchCache } from "../execution/github-batch-cache.service.js";
import type { HsmActionContext } from "./hsm-action-handlers.js";

@Injectable()
export class HsmGuardHandlers {
  constructor(
    @Inject(GitHubBatchCache) private readonly githubBatchCache: GitHubBatchCache,
  ) {}

  async prExistsForBranch(ctx: HsmActionContext): Promise<boolean> {
    const repo = ctx.workItem.repo?.trim();
    const branch = ctx.workItem.branch?.trim();
    if (!repo || !branch) {
      return false;
    }
    const pullRequest = await this.githubBatchCache.findPullRequestForBranch(repo, branch);
    return pullRequest !== null;
  }
}
