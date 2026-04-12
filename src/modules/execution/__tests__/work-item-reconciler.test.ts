import { describe, expect, it, vi } from "vitest";
import {
  decideNextAction,
  WorkItemReconcilerService,
  type GitRunner,
  type ReconcilerDiskStore,
} from "../work-item-reconciler.service.js";
import type { ExecutionRunRecord, ExecutionRunStatus } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";
import type { ReconciledPullRequest, ReconciledWorktree } from "../work-item-reconciler.types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-176",
    name: "Work item reconciler",
    kind: "issue",
    state: "in_progress",
    repo: "fusupo/escapement-studio",
    issue_number: 176,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/176",
    scope_hint: null,
    branch: "studio-176-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_176",
    run_type: "execution",
    work_item_id: "studio-176",
    work_item_name: "Work item reconciler",
    status: "completed",
    created_at: "2026-04-10T00:00:00.000Z",
    updated_at: "2026-04-10T00:00:00.000Z",
    completed_at: "2026-04-10T00:05:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/176",
    branch: "studio-176-branch",
    base_ref: "develop",
    worktree_path: "/tmp/worktrees/studio-176-branch",
    artifact_dir: "/tmp/runs/exec_176",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

describe("decideNextAction (decision table)", () => {
  const workItem = makeWorkItem();
  const existsWorktree: ReconciledWorktree = {
    exists: true,
    branch: "studio-176-branch",
    commits_ahead: 2,
    dirty: false,
  };

  it("row 1: completed run + merged PR → close_out", () => {
    const pr: ReconciledPullRequest = {
      number: 200,
      state: "MERGED",
      merged_at: "2026-04-10T01:00:00.000Z",
      url: "https://github.com/fusupo/escapement-studio/pull/200",
    };
    const result = decideNextAction({ workItem, latestRun: makeRun(), worktree: existsWorktree, githubPr: pr });
    expect(result.nextAction).toBe("close_out");
    expect(result.rationale).toMatch(/merged/);
  });

  it("row 2: completed run + open PR → awaiting_review", () => {
    const pr: ReconciledPullRequest = {
      number: 201,
      state: "OPEN",
      merged_at: null,
      url: "https://github.com/fusupo/escapement-studio/pull/201",
    };
    const result = decideNextAction({ workItem, latestRun: makeRun(), worktree: existsWorktree, githubPr: pr });
    expect(result.nextAction).toBe("awaiting_review");
    expect(result.rationale).toMatch(/open/);
  });

  it("row 3: completed run + closed (not merged) PR → abandon", () => {
    const pr: ReconciledPullRequest = {
      number: 202,
      state: "CLOSED",
      merged_at: null,
      url: "https://github.com/fusupo/escapement-studio/pull/202",
    };
    const result = decideNextAction({ workItem, latestRun: makeRun(), worktree: existsWorktree, githubPr: pr });
    expect(result.nextAction).toBe("abandon");
    expect(result.rationale).toMatch(/closed without merge/);
  });

  it("row 4: completed run + no PR + commits ahead → open_pr", () => {
    const result = decideNextAction({
      workItem,
      latestRun: makeRun(),
      worktree: existsWorktree,
      githubPr: null,
    });
    expect(result.nextAction).toBe("open_pr");
    expect(result.rationale).toMatch(/2 commit/);
  });

  it("row 5: completed run + no PR + no commits ahead → none", () => {
    const result = decideNextAction({
      workItem,
      latestRun: makeRun(),
      worktree: { ...existsWorktree, commits_ahead: 0 },
      githubPr: null,
    });
    expect(result.nextAction).toBe("none");
  });

  it("row 6: error run → investigate", () => {
    const result = decideNextAction({
      workItem,
      latestRun: makeRun({
        status: "error",
        progress_message: "Execution failed: boom",
      }),
      worktree: existsWorktree,
      githubPr: null,
    });
    expect(result.nextAction).toBe("investigate");
    expect(result.rationale).toMatch(/boom/);
  });

  it("row 7a: no run on disk → relaunch", () => {
    const result = decideNextAction({
      workItem,
      latestRun: null,
      worktree: existsWorktree,
      githubPr: null,
    });
    expect(result.nextAction).toBe("relaunch");
    expect(result.rationale).toMatch(/worktree exists/);
  });

  it("row 7b: non-terminal run (e.g. running) → relaunch", () => {
    const result = decideNextAction({
      workItem,
      latestRun: makeRun({ status: "running" as ExecutionRunStatus }),
      worktree: existsWorktree,
      githubPr: null,
    });
    expect(result.nextAction).toBe("relaunch");
  });

  it("blocked run is treated as investigate (maps to investigate row)", () => {
    const result = decideNextAction({
      workItem,
      latestRun: makeRun({ status: "blocked" }),
      worktree: existsWorktree,
      githubPr: null,
    });
    expect(result.nextAction).toBe("investigate");
  });
});

describe("WorkItemReconcilerService.reconcile", () => {
  function makeService(stubs: {
    workItems: WorkItemRecord[];
    runs: ExecutionRunRecord[];
    pr?: { state: string; number: number; url: string; merged_at: string | null } | null;
    git?: Partial<Record<"count" | "status", string>>;
    worktreeExists?: boolean;
    issueState?: string | null;
  }) {
    const service = Object.create(WorkItemReconcilerService.prototype) as WorkItemReconcilerService;
    const diskStore: ReconcilerDiskStore = {
      loadRunRecords: vi.fn(() => stubs.runs),
      detectAndMarkOrphans: vi.fn(() => []),
    };
    const gitRunner: GitRunner = {
      run: vi.fn((args: string[]) => {
        if (args[0] === "rev-list") return stubs.git?.count ?? "0\n";
        if (args[0] === "status") return stubs.git?.status ?? "";
        return "";
      }),
    };
    const workItemsService = {
      list: vi.fn((filters: { state?: string }) => {
        if (filters.state === "in_progress") {
          return stubs.workItems.filter((w) => w.state === "in_progress");
        }
        return stubs.workItems;
      }),
      get: vi.fn((id: string) => {
        const match = stubs.workItems.find((w) => w.id === id);
        if (!match) throw new Error("not found");
        return match;
      }),
    };
    const githubBatchCache = {
      findPullRequestForBranch: vi.fn(async () => stubs.pr ?? null),
      listIssues: vi.fn(async () => new Map([[176, { state: (stubs.issueState ?? "open").toLowerCase() }]])),
    };

    (service as any).logger = { log: vi.fn(), warn: vi.fn() };
    (service as any).artifactRoot = "/tmp/artifact-root";
    (service as any).runsDir = "/tmp/artifact-root/runs";
    (service as any).worktreeRoot = "/tmp/artifact-root/worktrees";
    (service as any).workItemsService = workItemsService;
    (service as any).githubBatchCache = githubBatchCache;
    service.diskStore = diskStore;
    service.gitRunner = gitRunner;
    service.pathExists = () => stubs.worktreeExists ?? false;

    return { service, diskStore, gitRunner, workItemsService, githubBatchCache };
  }

  it("returns an empty array when no work items are in a reconcilable state", async () => {
    const { service } = makeService({
      workItems: [makeWorkItem({ state: "planned" })],
      runs: [],
    });
    expect(await service.reconcile()).toEqual([]);
  });

  // Regression: ADR 014 split in_progress into in_progress → open_pr →
  // merged_pr → done, and issue #193 widens the reconcilable set further
  // to include run_errored and closed. Before this fix, selectWorkItems
  // only picked in_progress, so downstream operator rows stayed hidden.
  it("includes merged_pr work items and surfaces close_out rows", async () => {
    const run = makeRun({
      pull_request: {
        number: 190,
        url: "https://github.com/x/y/pull/190",
        title: "t",
        body: "b",
        base_ref: "develop",
        head_ref: "studio-176-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
        state: "MERGED",
        merged_at: "2026-04-11T01:00:00.000Z",
        merge_commit_sha: "deadbeef",
      },
    });
    const { service } = makeService({
      workItems: [makeWorkItem({ state: "merged_pr" })],
      runs: [run],
      worktreeExists: true,
    });
    const reconciled = await service.reconcile();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].graph_state).toBe("merged_pr");
    expect(reconciled[0].next_action).toBe("close_out");
  });

  it("includes open_pr work items and surfaces awaiting_review rows", async () => {
    const run = makeRun({
      pull_request: {
        number: 191,
        url: "https://github.com/x/y/pull/191",
        title: "t",
        body: "b",
        base_ref: "develop",
        head_ref: "studio-176-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
        state: "OPEN",
        merged_at: null,
      },
    });
    const { service } = makeService({
      workItems: [makeWorkItem({ state: "open_pr" })],
      runs: [run],
      worktreeExists: true,
    });
    const reconciled = await service.reconcile();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].graph_state).toBe("open_pr");
    expect(reconciled[0].next_action).toBe("awaiting_review");
  });

  it("includes run_errored work items in the reconciled feed", async () => {
    const { service } = makeService({
      workItems: [makeWorkItem({ state: "run_errored" })],
      runs: [makeRun({ status: "error", progress_message: "boom" })],
      worktreeExists: true,
    });
    const reconciled = await service.reconcile();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].graph_state).toBe("run_errored");
    expect(reconciled[0].next_action).toBe("investigate");
  });

  it("includes closed work items in the reconciled feed", async () => {
    const run = makeRun({
      pull_request: {
        number: 192,
        url: "https://github.com/x/y/pull/192",
        title: "t",
        body: "b",
        base_ref: "develop",
        head_ref: "studio-176-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
        state: "CLOSED",
        merged_at: null,
      },
    });
    const { service } = makeService({
      workItems: [makeWorkItem({ state: "closed" })],
      runs: [run],
      worktreeExists: true,
    });
    const reconciled = await service.reconcile();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].graph_state).toBe("closed");
    expect(reconciled[0].next_action).toBe("abandon");
  });

  it("excludes done, archived, cancelled, and deferred work items from the reconciled feed", async () => {
    const { service } = makeService({
      workItems: [
        makeWorkItem({ id: "studio-done", state: "done" }),
        makeWorkItem({ id: "studio-archived", state: "archived" }),
        makeWorkItem({ id: "studio-cancelled", state: "cancelled" }),
        makeWorkItem({ id: "studio-deferred", state: "deferred" }),
      ],
      runs: [makeRun()],
    });
    expect(await service.reconcile()).toEqual([]);
  });

  it("uses the stored PR on the latest run without calling gh", async () => {
    const run = makeRun({
      pull_request: {
        number: 200,
        url: "https://github.com/x/y/pull/200",
        title: "t",
        body: "b",
        base_ref: "develop",
        head_ref: "studio-176-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
        state: "MERGED",
        merged_at: "2026-04-10T01:00:00.000Z",
        merge_commit_sha: "deadbeef",
      },
    });
    const { service, githubBatchCache } = makeService({ workItems: [makeWorkItem()], runs: [run], worktreeExists: true });

    const reconciled = await service.reconcile();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].github_pr).toMatchObject({ number: 200, state: "MERGED" });
    expect(reconciled[0].next_action).toBe("close_out");
    expect(githubBatchCache.findPullRequestForBranch).not.toHaveBeenCalled();
    // Issue #85: merged PR triggers the issue-state probe and populates
    // github_issue_state.
    expect(githubBatchCache.listIssues).toHaveBeenCalledWith("fusupo/escapement-studio");
    expect(reconciled[0].github_issue_state).toBe("open");
  });

  it("populates github_issue_state from the batch cache when PR is merged", async () => {
    const run = makeRun({
      pull_request: {
        number: 200,
        url: "https://github.com/x/y/pull/200",
        title: "t",
        body: "b",
        base_ref: "develop",
        head_ref: "studio-176-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
        state: "MERGED",
        merged_at: "2026-04-10T01:00:00.000Z",
        merge_commit_sha: "deadbeef",
      },
    });
    const { service } = makeService({
      workItems: [makeWorkItem()],
      runs: [run],
      worktreeExists: true,
      issueState: "CLOSED",
    });
    const reconciled = await service.reconcile();
    expect(reconciled[0].github_issue_state).toBe("closed");
  });

  it("does not call listIssues when PR is open (skip optimization)", async () => {
    const { service, githubBatchCache } = makeService({
      workItems: [makeWorkItem()],
      runs: [makeRun()],
      pr: { number: 201, state: "OPEN", merged_at: null, url: "https://github.com/x/y/pull/201" },
      git: { count: "2\n" },
      worktreeExists: true,
    });
    const reconciled = await service.reconcile();
    expect(githubBatchCache.listIssues).not.toHaveBeenCalled();
    expect(reconciled[0].github_issue_state).toBeNull();
  });

  it("does not call listIssues when PR is absent", async () => {
    const { service, githubBatchCache } = makeService({
      workItems: [makeWorkItem()],
      runs: [makeRun()],
      git: { count: "2\n" },
      worktreeExists: true,
    });
    const reconciled = await service.reconcile();
    expect(githubBatchCache.listIssues).not.toHaveBeenCalled();
    expect(reconciled[0].github_issue_state).toBeNull();
  });

  it("degrades gracefully when listIssues throws", async () => {
    const run = makeRun({
      pull_request: {
        number: 200,
        url: "https://github.com/x/y/pull/200",
        title: "t",
        body: "b",
        base_ref: "develop",
        head_ref: "studio-176-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
        state: "MERGED",
        merged_at: "2026-04-10T01:00:00.000Z",
        merge_commit_sha: "deadbeef",
      },
    });
    const { service, githubBatchCache } = makeService({
      workItems: [makeWorkItem()],
      runs: [run],
      worktreeExists: true,
    });
    (githubBatchCache.listIssues as any).mockRejectedValueOnce(new Error("gh rate limited"));

    const reconciled = await service.reconcile();
    expect(reconciled[0].github_issue_state).toBeNull();
    expect(((service as any).logger.warn as any).mock.calls.length).toBeGreaterThan(0);
  });

  it("calls GitHubBatchCache.findPullRequestForBranch when no stored PR", async () => {
    const { service, githubBatchCache } = makeService({
      workItems: [makeWorkItem()],
      runs: [makeRun()],
      pr: { number: 201, state: "OPEN", merged_at: null, url: "https://github.com/x/y/pull/201" },
      git: { count: "2\n" },
      worktreeExists: true,
    });

    const reconciled = await service.reconcile();
    expect(reconciled[0].github_pr).toMatchObject({ number: 201, state: "OPEN" });
    expect(reconciled[0].next_action).toBe("awaiting_review");
    expect(githubBatchCache.findPullRequestForBranch).toHaveBeenCalledWith(
      "fusupo/escapement-studio",
      "studio-176-branch",
    );
  });

  it("degrades gracefully when findPullRequestForBranch throws", async () => {
    const { service, githubBatchCache } = makeService({
      workItems: [makeWorkItem()],
      runs: [makeRun()],
      git: { count: "3\n" },
      worktreeExists: true,
    });
    (githubBatchCache.findPullRequestForBranch as any).mockRejectedValueOnce(new Error("gh rate limited"));

    const reconciled = await service.reconcile();
    expect(reconciled[0].github_pr).toBeNull();
    // With commits_ahead > 0 and no PR → open_pr
    expect(reconciled[0].next_action).toBe("open_pr");
  });

  it("filters by single work_item_id when provided", async () => {
    const a = makeWorkItem({ id: "studio-100" });
    const b = makeWorkItem({ id: "studio-176" });
    const { service, workItemsService } = makeService({
      workItems: [a, b],
      runs: [makeRun({ work_item_id: "studio-176" })],
    });
    const reconciled = await service.reconcile({ work_item_id: "studio-176" });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].work_item_id).toBe("studio-176");
    expect(workItemsService.get).toHaveBeenCalledWith("studio-176");
  });

  it("relaunch row when no run recorded and worktree missing", async () => {
    const { service } = makeService({
      workItems: [makeWorkItem()],
      runs: [],
      worktreeExists: false,
    });
    const reconciled = await service.reconcile();
    expect(reconciled[0].next_action).toBe("relaunch");
    expect(reconciled[0].latest_run).toBeNull();
  });
});

describe("WorkItemReconcilerService.runStartupReconcile", () => {
  it("invokes detectOrphans then reconcile and emits a summary line", async () => {
    const service = Object.create(WorkItemReconcilerService.prototype) as WorkItemReconcilerService;
    const orphan = { run_id: "exec_x", previous_status: "running" as const, rewritten_at: "2026-04-10T05:00:00.000Z" };
    const diskStore: ReconcilerDiskStore = {
      loadRunRecords: vi.fn(() => []),
      detectAndMarkOrphans: vi.fn(() => [orphan]),
    };
    const logger = { log: vi.fn(), warn: vi.fn() };
    (service as any).logger = logger;
    (service as any).runsDir = "/tmp/runs";
    (service as any).workItemsService = { list: vi.fn(() => []), get: vi.fn() };
    (service as any).githubBatchCache = { findPullRequestForBranch: vi.fn(), listIssues: vi.fn() };
    service.diskStore = diskStore;
    service.gitRunner = { run: vi.fn(() => "") };
    service.pathExists = () => false;

    const result = await service.runStartupReconcile();
    expect(result.orphans).toHaveLength(1);
    expect(result.reconciled).toHaveLength(0);
    expect(result.summary.orphans_rewritten).toBe(1);
    expect(logger.log).toHaveBeenCalled();
    expect((logger.log.mock.calls[0]?.[0] ?? "") as string).toMatch(/orphan/);
  });
});
