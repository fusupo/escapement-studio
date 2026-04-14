import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubBatchCache } from "../github-batch-cache.service.js";

describe("GitHubBatchCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T00:00:00.000Z"));
  });

  function makeCache() {
    const githubService = {
      normalizeRepo: vi.fn((repo: string) => repo.trim().replace(/^\/+|\/+$/g, "").toLowerCase()),
      listPullRequests: vi.fn(async () => [
        {
          number: 12,
          state: "MERGED" as const,
          merged_at: "2026-04-11T12:00:00.000Z",
          head_ref: "studio-194-branch",
          base_ref: "develop",
          url: "https://github.com/fusupo/escapement-studio/pull/12",
          title: "Batch cache",
          is_draft: false,
        },
      ]),
      listIssues: vi.fn(async () => [
        {
          number: 194,
          state: "closed" as const,
          closed_at: "2026-04-11T13:00:00.000Z",
          url: "https://github.com/fusupo/escapement-studio/issues/194",
          title: "Batch cache issue",
        },
      ]),
    };
    const cache = new GitHubBatchCache(githubService as any);
    (cache as any).logger = { warn: vi.fn() };
    return { cache, githubService };
  }

  it("fetches PRs once and reuses the same Map within the TTL", async () => {
    const { cache, githubService } = makeCache();

    const first = await cache.listPullRequests("FUSUPO/ESCAPEMENT-STUDIO");
    const second = await cache.listPullRequests("fusupo/escapement-studio");

    expect(githubService.listPullRequests).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.get(12)?.state).toBe("MERGED");
  });

  it("refetches after the TTL expires", async () => {
    const { cache, githubService } = makeCache();

    const first = await cache.listPullRequests("fusupo/escapement-studio");
    vi.advanceTimersByTime(60_001);
    const second = await cache.listPullRequests("fusupo/escapement-studio");

    expect(githubService.listPullRequests).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("invalidate(repo) forces the next PR read to refetch", async () => {
    const { cache, githubService } = makeCache();

    await cache.listPullRequests("fusupo/escapement-studio");
    cache.invalidate("fusupo/escapement-studio");
    await cache.listPullRequests("fusupo/escapement-studio");

    expect(githubService.listPullRequests).toHaveBeenCalledTimes(2);
  });

  it("supports write-through PR updates", async () => {
    const { cache } = makeCache();

    await cache.listPullRequests("fusupo/escapement-studio");
    cache.upsertPullRequest("fusupo/escapement-studio", {
      number: 77,
      state: "OPEN",
      merged_at: null,
      head_ref: "feature-x",
      base_ref: "develop",
      url: "https://github.com/fusupo/escapement-studio/pull/77",
      title: "Feature X",
      is_draft: true,
    });

    const pulls = await cache.listPullRequests("fusupo/escapement-studio");
    expect(pulls.get(77)).toMatchObject({ head_ref: "feature-x", is_draft: true });
  });

  it("deduplicates concurrent PR reads for the same repo", async () => {
    const { cache, githubService } = makeCache();
    let resolveFetch: ((value: any) => void) | undefined;
    githubService.listPullRequests.mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const first = cache.listPullRequests("fusupo/escapement-studio");
    const second = cache.listPullRequests("fusupo/escapement-studio");

    expect(githubService.listPullRequests).toHaveBeenCalledTimes(1);

    resolveFetch?.([
      {
        number: 12,
        state: "OPEN",
        merged_at: null,
        head_ref: "studio-194-branch",
        base_ref: "develop",
        url: "https://github.com/fusupo/escapement-studio/pull/12",
        title: "Batch cache",
        is_draft: false,
      },
    ]);

    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left.get(12)?.state).toBe("OPEN");
  });

  it("returns null when no PR matches the branch", async () => {
    const { cache } = makeCache();
    expect(await cache.findPullRequestForBranch("fusupo/escapement-studio", "missing-branch")).toBeNull();
  });

  it("finds PRs by branch from the cached PR map", async () => {
    const { cache } = makeCache();
    const found = await cache.findPullRequestForBranch("fusupo/escapement-studio", "studio-194-branch");
    expect(found).toMatchObject({ number: 12, state: "MERGED" });
  });

  it("caches issues with TTL, invalidateAll, and write-through", async () => {
    const { cache, githubService } = makeCache();

    const first = await cache.listIssues("fusupo/escapement-studio");
    const second = await cache.listIssues("fusupo/escapement-studio");
    expect(first).toBe(second);
    expect(githubService.listIssues).toHaveBeenCalledTimes(1);

    cache.upsertIssue("fusupo/escapement-studio", {
      number: 199,
      state: "open",
      closed_at: null,
      url: "https://github.com/fusupo/escapement-studio/issues/199",
      title: "New issue",
    });
    expect((await cache.listIssues("fusupo/escapement-studio")).get(199)?.state).toBe("open");

    cache.invalidateAll();
    await cache.listIssues("fusupo/escapement-studio");
    expect(githubService.listIssues).toHaveBeenCalledTimes(2);
  });

  it("surfaces GitHub fetch failures", async () => {
    const { cache, githubService } = makeCache();
    githubService.listPullRequests.mockRejectedValueOnce(new Error("gh auth failed"));
    await expect(cache.listPullRequests("fusupo/escapement-studio")).rejects.toThrow("gh auth failed");
  });

  it("preserves write-through updates made during an in-flight PR fetch", async () => {
    const { cache, githubService } = makeCache();
    let resolveFetch: ((value: any) => void) | undefined;
    githubService.listPullRequests.mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = cache.listPullRequests("fusupo/escapement-studio");
    cache.upsertPullRequest("fusupo/escapement-studio", {
      number: 88,
      state: "OPEN",
      merged_at: null,
      head_ref: "hotfix",
      base_ref: "develop",
      url: "https://github.com/fusupo/escapement-studio/pull/88",
      title: "Hotfix",
      is_draft: false,
    });

    resolveFetch?.([
      {
        number: 12,
        state: "CLOSED",
        merged_at: null,
        head_ref: "studio-194-branch",
        base_ref: "develop",
        url: "https://github.com/fusupo/escapement-studio/pull/12",
        title: "Batch cache",
        is_draft: false,
      },
    ]);

    const pulls = await pending;
    expect(pulls.get(88)).toMatchObject({ head_ref: "hotfix" });
    expect(pulls.has(12)).toBe(false);
  });

  it("reports cache diagnostics", async () => {
    const { cache } = makeCache();

    await cache.listPullRequests("fusupo/escapement-studio");
    await cache.listIssues("fusupo/escapement-studio");

    expect(cache.getCacheInfo()).toEqual([
      expect.objectContaining({
        repo: "fusupo/escapement-studio",
        pr_count: 1,
        issue_count: 1,
        prs_fetched_at: "2026-04-12T00:00:00.000Z",
        issues_fetched_at: "2026-04-12T00:00:00.000Z",
      }),
    ]);
  });
});
