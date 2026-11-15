import { Injectable } from "@nestjs/common";
import { runGh } from "../../lib/gh-runner.js";
import type { CachedIssue, CachedPullRequest } from "./github-batch-cache.service.js";

/**
 * Targeted GitHub reads (#292): the state of one branch's pull requests
 * or of one issue, in a single short `gh` call each. The cache sweep
 * uses these to check only the work items that are waiting on GitHub,
 * instead of listing every PR and issue in the repo.
 *
 * Results use the batch cache's shapes so they can be written through
 * to it. Failures reject; the caller decides what a missing answer means.
 */
@Injectable()
export class GitHubItemLookup {
  /** Every pull request whose head branch is exactly `branch`, any state. */
  async pullRequestsForBranch(repo: string, branch: string): Promise<CachedPullRequest[]> {
    const head = branch.trim();
    const raw = JSON.parse(await runGh([
      "pr", "list",
      "--repo", repo.trim(),
      "--head", head,
      "--state", "all",
      "--json", "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt",
    ])) as RawPullRequest[];
    return raw
      .filter((pull) => pull.headRefName === head)
      .map((pull) => ({
        number: pull.number,
        state: pullRequestState(pull.state, pull.mergedAt ?? null),
        merged_at: pull.mergedAt ?? null,
        head_ref: pull.headRefName ?? "",
        base_ref: pull.baseRefName ?? "",
        url: pull.url,
        title: pull.title,
        is_draft: Boolean(pull.isDraft),
      }));
  }

  async issue(repo: string, issueNumber: number): Promise<CachedIssue> {
    const raw = JSON.parse(await runGh([
      "issue", "view", String(issueNumber),
      "--repo", repo.trim(),
      "--json", "number,title,url,state,closedAt",
    ])) as RawIssue;
    return {
      number: raw.number,
      state: `${raw.state}`.toLowerCase() === "closed" ? "closed" : "open",
      closed_at: raw.closedAt ?? null,
      url: raw.url,
      title: raw.title,
    };
  }
}

interface RawPullRequest {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  mergedAt?: string | null;
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  closedAt?: string | null;
}

function pullRequestState(state: string, mergedAt: string | null): CachedPullRequest["state"] {
  if (mergedAt) return "MERGED";
  const normalized = `${state}`.trim().toUpperCase();
  return normalized === "CLOSED" || normalized === "MERGED" ? normalized : "OPEN";
}
