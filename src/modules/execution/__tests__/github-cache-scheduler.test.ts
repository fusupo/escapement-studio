import { describe, expect, it, vi, beforeEach } from "vitest";
import { GitHubCacheScheduler } from "../github-cache-scheduler.service.js";
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

  const scheduler = Object.create(GitHubCacheScheduler.prototype) as GitHubCacheScheduler;
  (scheduler as unknown as { cache: typeof cache }).cache = cache;
  (scheduler as unknown as { workItemsService: typeof workItemsService }).workItemsService = workItemsService;
  (scheduler as unknown as { hsmService: typeof hsmService }).hsmService = hsmService;
  (scheduler as unknown as { logger: { log: () => void; warn: () => void } }).logger = {
    log: vi.fn(),
    warn: vi.fn(),
  };

  return { scheduler, cache, workItemsService, hsmService };
}

describe("GitHubCacheScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no repos are tracked", async () => {
    const { scheduler } = makeService({ workItems: [] });
    const results = await scheduler.sweep();
    expect(results).toEqual([]);
  });

  it("invalidates and refetches cache for tracked repos", async () => {
    const { scheduler, cache } = makeService({
      workItems: [makeWorkItem()],
    });
    await scheduler.sweep();
    expect(cache.invalidate).toHaveBeenCalledWith("fusupo/escapement-studio");
    expect(cache.listPullRequests).toHaveBeenCalledWith("fusupo/escapement-studio");
    expect(cache.listIssues).toHaveBeenCalledWith("fusupo/escapement-studio");
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
    const { scheduler, hsmService } = makeService({
      workItems: [makeWorkItem({ state: "open_pr" })],
      prMap,
    });
    const results = await scheduler.sweep();
    expect(hsmService.dispatch).toHaveBeenCalledWith("studio-100", expect.objectContaining({
      type: "gh.pr_merged",
    }));
    expect(results[0].dispatched).toBe(1);
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
    const { scheduler, cache } = makeService({
      workItems: [makeWorkItem()],
    });
    await scheduler.sweep("fusupo/other-repo");
    expect(cache.invalidate).toHaveBeenCalledWith("fusupo/other-repo");
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
  });

  it("swallows per-repo fetch errors and continues", async () => {
    const { scheduler, cache } = makeService({
      workItems: [makeWorkItem(), makeWorkItem({ id: "studio-200", repo: "fusupo/other-repo" })],
    });
    (cache.listPullRequests as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rate limited"));
    const results = await scheduler.sweep();
    // First repo fails, second succeeds
    expect(results).toHaveLength(2);
    expect(results[0].dispatched).toBe(0); // failed repo
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
    const { scheduler, hsmService } = makeService({
      workItems: [makeWorkItem({ state: "open_pr" })],
      prMap,
    });
    (hsmService.dispatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HSM error"));
    const results = await scheduler.sweep();
    expect(results[0].dispatched).toBe(0);
  });
});
