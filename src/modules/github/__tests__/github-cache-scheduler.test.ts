import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubCacheScheduler } from "../github-cache-scheduler.service.js";
import { GitHubRepoTruthRefreshedEvent, normalizeGitHubRepo } from "../events/github-repo-truth-refreshed.event.js";
import { WorkItemMergedEvent } from "../../execution/events/work-item-merged.event.js";
import type { WorkItemRecord } from "../../graph/types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-100",
    name: "Test item",
    kind: "issue",
    state: "open_pr",
    repo: "fusupo/escapement-studio",
    issue_number: 100,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/100",
    scope_hint: null,
    branch: "studio-100-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeService(stubs: {
  workItems?: WorkItemRecord[];
  prMap?: Map<number, { number: number; state: string; merged_at: string | null; head_ref: string; base_ref: string; url: string; title: string; is_draft: boolean }>;
  issueMap?: Map<number, { number: number; state: string; closed_at: string | null; url: string; title: string }>;
} = {}) {
  const cache = {
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    listPullRequests: vi.fn(async () => stubs.prMap ?? new Map()),
    listIssues: vi.fn(async () => stubs.issueMap ?? new Map()),
    upsertPullRequest: vi.fn(),
    upsertIssue: vi.fn(),
  };
  // Targeted lookups answer from the same stub maps as the listings.
  const lookup = {
    pullRequestsForBranch: vi.fn(async (_repo: string, branch: string) =>
      Array.from((stubs.prMap ?? new Map()).values()).filter((pr) => pr.head_ref === branch)),
    issue: vi.fn(async (_repo: string, issueNumber: number) => {
      const issue = stubs.issueMap?.get(issueNumber);
      if (!issue) throw new Error(`issue #${issueNumber} not found`);
      return issue;
    }),
  };
  const workItemsService = {
    list: vi.fn(() => stubs.workItems ?? []),
    get: vi.fn((id: string) => {
      const match = (stubs.workItems ?? []).find((w) => w.id === id);
      if (!match) throw new Error("not found");
      return match;
    }),
  };
  const hsmService = {
    dispatch: vi.fn(async () => ({
      work_item_id: "studio-100",
      prev_state: "open_pr",
      next_state: "merged_pr",
      event: { type: "gh.pr_merged" },
      applied_actions: [],
      mutation_applied: true,
      rejected: false,
    })),
  };
  // Phase 5 (#225): the scheduler now injects EventBus and publishes
  // WorkItemMergedEvent after a successful gh.pr_merged dispatch.
  const eventBus = { publish: vi.fn() };

  const scheduler = Object.create(GitHubCacheScheduler.prototype) as GitHubCacheScheduler;
  (scheduler as unknown as { cache: typeof cache }).cache = cache;
  (scheduler as unknown as { lookup: typeof lookup }).lookup = lookup;
  (scheduler as unknown as { workItemsService: typeof workItemsService }).workItemsService = workItemsService;
  (scheduler as unknown as { hsmService: typeof hsmService }).hsmService = hsmService;
  (scheduler as unknown as { eventBus: typeof eventBus }).eventBus = eventBus;
  (scheduler as unknown as { inFlight: Map<string, unknown> }).inFlight = new Map();
  (scheduler as unknown as { logger: { log: () => void; warn: () => void } }).logger = {
    log: vi.fn(),
    warn: vi.fn(),
  };

  return { scheduler, cache, lookup, workItemsService, hsmService, eventBus };
}

const PR = { number: 7, state: "MERGED", merged_at: "2026-04-11T00:00:00Z", head_ref: "studio-100-branch", base_ref: "develop", url: "https://github.com/fusupo/escapement-studio/pull/7", title: "PR", is_draft: false };

describe("GitHubCacheScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["fusupo/Repo", "https://github.com/fusupo/Repo.git/", "git@github.com:fusupo/Repo.git", "ssh://git@github.com/fusupo/Repo.git"])("normalizes %s", input => {
    expect(normalizeGitHubRepo(input)).toBe("fusupo/repo");
  });

  it("rejects invalid identities", () => {
    for (const value of ["https://example.com/a/b", "a/b/issues", "a", "../b"]) expect(normalizeGitHubRepo(value)).toBeNull();
  });

  it("publishes only after the lookups, before dispatch", async () => {
    const { scheduler, lookup, eventBus, hsmService } = makeService({
      workItems: [makeWorkItem()],
      prMap: new Map([[7, PR]]),
    });
    let complete!: (value: typeof PR[]) => void;
    lookup.pullRequestsForBranch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const sweep = scheduler.sweep();
    await Promise.resolve();
    expect(eventBus.publish).not.toHaveBeenCalled();
    complete([PR]);
    await sweep;
    expect(eventBus.publish).toHaveBeenCalledWith(new GitHubRepoTruthRefreshedEvent("fusupo/escapement-studio", expect.any(Number)));
    expect(eventBus.publish.mock.invocationCallOrder[0]).toBeLessThan(hsmService.dispatch.mock.invocationCallOrder[0]);
  });

  it("does not publish for a repo with a failed lookup; isolates repos", async () => {
    const { scheduler, lookup, eventBus } = makeService({ workItems: [makeWorkItem(), makeWorkItem({ id: "studio-200", repo: "a/b" })] });
    lookup.pullRequestsForBranch.mockRejectedValueOnce(new Error("unavailable"));
    await scheduler.sweep();
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(new GitHubRepoTruthRefreshedEvent("a/b", expect.any(Number)));
  });

  it("shares one run between overlapping sweeps of a repo (#291)", async () => {
    const { scheduler, lookup, hsmService } = makeService({
      workItems: [makeWorkItem()],
      prMap: new Map([[7, PR]]),
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    lookup.pullRequestsForBranch.mockImplementationOnce(async () => { await gate; return [PR]; });
    const first = scheduler.sweep();
    const second = scheduler.sweep("fusupo/escapement-studio");
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a[0].dispatched).toBe(1);
    expect(lookup.pullRequestsForBranch).toHaveBeenCalledTimes(1);
    expect(hsmService.dispatch).toHaveBeenCalledTimes(1);

    // Once it settles, the next sweep runs again, also after a failure.
    lookup.pullRequestsForBranch.mockRejectedValueOnce(new Error("unavailable"));
    await scheduler.sweep();
    await scheduler.sweep();
    expect(lookup.pullRequestsForBranch).toHaveBeenCalledTimes(3);
  });

  describe("targeted lookups (#292)", () => {
    it("makes one call per waiting item and no listing", async () => {
      const { scheduler, cache, lookup } = makeService({
        workItems: [
          makeWorkItem({ id: "studio-1", state: "pre_pr.in_progress", branch: "studio-1-branch" }),
          makeWorkItem({ id: "studio-2", state: "open_pr", branch: "studio-2-branch" }),
          makeWorkItem({ id: "studio-3", state: "merged_pr", issue_number: 3 }),
          makeWorkItem({ id: "studio-4", state: "done", branch: "studio-4-branch", issue_number: 4 }),
          makeWorkItem({ id: "studio-5", state: "ready", branch: "studio-5-branch", issue_number: 5 }),
        ],
        issueMap: new Map([[3, { number: 3, state: "open", closed_at: null, url: "u", title: "t" }]]),
      });
      const results = await scheduler.sweep();
      expect(lookup.pullRequestsForBranch.mock.calls).toEqual([
        ["fusupo/escapement-studio", "studio-1-branch"],
        ["fusupo/escapement-studio", "studio-2-branch"],
      ]);
      expect(lookup.issue.mock.calls).toEqual([["fusupo/escapement-studio", 3]]);
      expect(cache.invalidate).not.toHaveBeenCalled();
      expect(cache.listPullRequests).not.toHaveBeenCalled();
      expect(cache.listIssues).not.toHaveBeenCalled();
      expect(results).toEqual([{ repo: "fusupo/escapement-studio", prs: 0, issues: 1, dispatched: 0 }]);
    });

    it("makes no GitHub call when nothing is waiting, and still announces the sweep", async () => {
      const { scheduler, cache, lookup, eventBus } = makeService({ workItems: [makeWorkItem({ state: "ready" })] });
      await scheduler.sweep();
      expect(lookup.pullRequestsForBranch).not.toHaveBeenCalled();
      expect(lookup.issue).not.toHaveBeenCalled();
      expect(cache.listPullRequests).not.toHaveBeenCalled();
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(GitHubRepoTruthRefreshedEvent));
    });

    it("looks a shared branch up once", async () => {
      const { scheduler, lookup } = makeService({
        workItems: [makeWorkItem({ id: "studio-1" }), makeWorkItem({ id: "studio-2", state: "in_progress" })],
      });
      await scheduler.sweep();
      expect(lookup.pullRequestsForBranch).toHaveBeenCalledTimes(1);
    });

    it("writes what it finds through to the batch cache", async () => {
      const issue = { number: 100, state: "closed", closed_at: "2026-04-11T02:00:00.000Z", url: "u", title: "t" };
      const { scheduler, cache } = makeService({
        workItems: [makeWorkItem(), makeWorkItem({ id: "studio-101", state: "merged_pr" })],
        prMap: new Map([[7, PR]]),
        issueMap: new Map([[100, issue]]),
      });
      await scheduler.sweep();
      expect(cache.upsertPullRequest).toHaveBeenCalledWith("fusupo/escapement-studio", PR);
      expect(cache.upsertIssue).toHaveBeenCalledWith("fusupo/escapement-studio", issue);
    });

    it("skips only the item whose lookup failed", async () => {
      const { scheduler, lookup, hsmService } = makeService({
        workItems: [
          makeWorkItem({ id: "studio-1", branch: "broken" }),
          makeWorkItem(),
        ],
        prMap: new Map([[7, PR]]),
      });
      lookup.pullRequestsForBranch.mockRejectedValueOnce(new Error("gh command timed out after 30000ms"));
      const results = await scheduler.sweep();
      expect(hsmService.dispatch).toHaveBeenCalledTimes(1);
      expect(hsmService.dispatch).toHaveBeenCalledWith("studio-100", expect.objectContaining({ type: "gh.pr_merged" }));
      expect(results[0].dispatched).toBe(1);
    });

    it("dispatches gh.pr_opened when an in_progress item's branch has a PR", async () => {
      const { scheduler, hsmService } = makeService({
        workItems: [makeWorkItem({ state: "pre_pr.in_progress" })],
        prMap: new Map([[7, { ...PR, state: "OPEN", merged_at: null }]]),
      });
      await scheduler.sweep();
      expect(hsmService.dispatch).toHaveBeenCalledWith("studio-100", expect.objectContaining({ type: "gh.pr_opened" }));
    });

    it("uses the state an item has after the lookups, not before", async () => {
      const { scheduler, workItemsService, hsmService } = makeService({ prMap: new Map([[7, PR]]) });
      workItemsService.list
        .mockReturnValueOnce([makeWorkItem()])   // repo discovery
        .mockReturnValueOnce([makeWorkItem()])   // what to look up
        .mockReturnValueOnce([makeWorkItem({ state: "merged_pr" })]); // Studio merged it meanwhile
      await scheduler.sweep();
      expect(hsmService.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("full-listing fallback", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) =>
      makeWorkItem({ id: `studio-${index}`, branch: `studio-${index}-branch` }));

    it("stays targeted at 8 lookups", async () => {
      const { scheduler, cache, lookup } = makeService({ workItems: many(8) });
      await scheduler.sweep();
      expect(lookup.pullRequestsForBranch).toHaveBeenCalledTimes(8);
      expect(cache.listPullRequests).not.toHaveBeenCalled();
    });

    it("invalidates and re-lists the repo above 8 lookups", async () => {
      const merged = { ...PR, head_ref: "studio-3-branch" };
      const { scheduler, cache, lookup, hsmService } = makeService({ workItems: many(9), prMap: new Map([[7, merged]]) });
      const results = await scheduler.sweep();
      expect(lookup.pullRequestsForBranch).not.toHaveBeenCalled();
      expect(cache.invalidate).toHaveBeenCalledWith("fusupo/escapement-studio");
      expect(cache.listPullRequests).toHaveBeenCalledWith("fusupo/escapement-studio");
      expect(cache.listIssues).toHaveBeenCalledWith("fusupo/escapement-studio");
      expect(hsmService.dispatch).toHaveBeenCalledWith("studio-3", expect.objectContaining({ type: "gh.pr_merged" }));
      expect(results[0]).toMatchObject({ prs: 1, dispatched: 1 });
    });

    it.each(["listPullRequests", "listIssues"] as const)("fails the repo's sweep on %s failure without publishing; isolates repos", async method => {
      const { scheduler, cache, eventBus } = makeService({ workItems: [...many(9), makeWorkItem({ id: "other", repo: "a/b" })] });
      cache[method].mockRejectedValueOnce(new Error("rate limited"));
      const results = await scheduler.sweep();
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ repo: "fusupo/escapement-studio", prs: 0, issues: 0, dispatched: 0 });
      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      expect(eventBus.publish).toHaveBeenCalledWith(new GitHubRepoTruthRefreshedEvent("a/b", expect.any(Number)));
    });
  });

  it("returns empty array when no repos are tracked", async () => {
    const { scheduler } = makeService({ workItems: [] });
    const results = await scheduler.sweep();
    expect(results).toEqual([]);
  });

  it("dispatches gh.pr_merged when open_pr item has a MERGED PR", async () => {
    const prMap = new Map([[100, {
      number: 100,
      state: "MERGED",
      merged_at: "2026-04-11T01:00:00.000Z",
      head_ref: "studio-100-branch",
      base_ref: "develop",
      url: "https://github.com/x/y/pull/100",
      title: "PR title",
      is_draft: false,
    }]]);
    const { scheduler, hsmService, eventBus } = makeService({
      workItems: [makeWorkItem({ state: "open_pr" })],
      prMap,
    });
    const results = await scheduler.sweep();
    expect(hsmService.dispatch).toHaveBeenCalledWith("studio-100", expect.objectContaining({
      type: "gh.pr_merged",
    }));
    expect(results[0].dispatched).toBe(1);

    // Phase 5 (#225): verify the WorkItemMergedEvent fired with the
    // expected payload after the HSM dispatch committed.
    const merged = eventBus.publish.mock.calls.map(([event]) => event).filter(event => event instanceof WorkItemMergedEvent);
    expect(merged).toHaveLength(1);
    const published = merged[0] as WorkItemMergedEvent;
    expect(published).toBeInstanceOf(WorkItemMergedEvent);
    expect(published.workItemId).toBe("studio-100");
    expect(published.pullRequest.number).toBe(100);
    expect(published.pullRequest.merged_at).toBe("2026-04-11T01:00:00.000Z");
    expect(published.source).toBe("scheduler");
  });

  it("dispatches gh.issue_closed when merged_pr item has a closed issue", async () => {
    const issueMap = new Map([[100, {
      number: 100,
      state: "closed",
      closed_at: "2026-04-11T02:00:00.000Z",
      url: "https://github.com/x/y/issues/100",
      title: "Issue title",
    }]]);
    const { scheduler, hsmService } = makeService({
      workItems: [makeWorkItem({ state: "merged_pr" })],
      issueMap,
    });
    await scheduler.sweep();
    expect(hsmService.dispatch).toHaveBeenCalledWith("studio-100", expect.objectContaining({
      type: "gh.issue_closed",
    }));
  });

  it("does NOT dispatch when work item is in a non-source state", async () => {
    const prMap = new Map([[100, {
      number: 100,
      state: "MERGED",
      merged_at: "2026-04-11T01:00:00.000Z",
      head_ref: "studio-100-branch",
      base_ref: "develop",
      url: "https://github.com/x/y/pull/100",
      title: "PR title",
      is_draft: false,
    }]]);
    const { scheduler, hsmService } = makeService({
      workItems: [makeWorkItem({ state: "done" })],
      prMap,
    });
    await scheduler.sweep();
    expect(hsmService.dispatch).not.toHaveBeenCalled();
  });

  it("scopes sweep to a single repo when repo param is provided", async () => {
    const { scheduler, lookup } = makeService({
      workItems: [makeWorkItem(), makeWorkItem({ id: "studio-200", repo: "fusupo/other-repo", branch: "other-branch" })],
    });
    const results = await scheduler.sweep("fusupo/other-repo");
    expect(results.map((result) => result.repo)).toEqual(["fusupo/other-repo"]);
    expect(lookup.pullRequestsForBranch.mock.calls).toEqual([["fusupo/other-repo", "other-branch"]]);
  });

  it("swallows per-dispatch HSM errors and continues", async () => {
    const prMap = new Map([[100, {
      number: 100,
      state: "MERGED",
      merged_at: "2026-04-11T01:00:00.000Z",
      head_ref: "studio-100-branch",
      base_ref: "develop",
      url: "https://github.com/x/y/pull/100",
      title: "PR title",
      is_draft: false,
    }]]);
    const { scheduler, hsmService, eventBus } = makeService({
      workItems: [makeWorkItem({ state: "open_pr" })],
      prMap,
    });
    (hsmService.dispatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HSM error"));
    const results = await scheduler.sweep();
    expect(results[0].dispatched).toBe(0);
    expect(eventBus.publish).toHaveBeenCalledWith(expect.any(GitHubRepoTruthRefreshedEvent));
  });
});
