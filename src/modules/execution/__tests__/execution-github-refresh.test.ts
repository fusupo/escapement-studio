import { describe, expect, it, vi } from "vitest";
import { PullRequestService } from "../pull-request.service.js";
import type { ExecutionRunRecord } from "../types.js";

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_123",
    run_type: "execution",
    work_item_id: "studio-91",
    work_item_name: "Refresh cached GitHub truth",
    status: "completed",
    created_at: "2026-04-09T00:00:00Z",
    updated_at: "2026-04-09T00:00:00Z",
    completed_at: "2026-04-09T00:00:00Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/91",
    branch: "studio-91-branch",
    base_ref: "develop",
    worktree_path: "/tmp/studio-91-branch",
    artifact_dir: "/tmp/runs/exec_123",
    prompt: "prompt",
    activity_log: [],
    safety_checks: [],
    pull_request: {
      number: 70,
      url: "https://github.com/fusupo/escapement-studio/pull/70",
      title: "Refresh cached GitHub truth",
      body: "PR body",
      base_ref: "develop",
      head_ref: "studio-91-branch",
      is_draft: false,
      created_at: "2026-04-09T00:00:00Z",
      state: "OPEN",
      merged_at: null,
      merge_commit_sha: null,
    },
    ...overrides,
  };
}

describe("PullRequestService.refreshPullRequestTruth", () => {
  /**
   * Phase 4e (#234): refreshPullRequestTruth lives on PullRequestService.
   * The harness targets `PullRequestService.prototype` and installs a
   * minimal `runStore` stub so the method body can reach
   * `this.runStore.listRecentRuns / updateRun / appendEvent / writeSummary`.
   *
   * No `registerPullRequestTruthRefresher` fires because the harness
   * bypasses DI via `Object.create` — the service constructor never
   * runs, so neither the GitHubService injection nor the callback
   * registration are exercised here. That's exactly what the
   * Phase 4a/4b/4c/4d prototype-based harness pattern has always done.
   */
  function makeRunStoreStub(runs: ExecutionRunRecord[]) {
    const updateRun = vi.fn((runId: string, patch: Partial<ExecutionRunRecord>) => {
      const index = runs.findIndex((run) => run.run_id === runId);
      if (index === -1) {
        return null;
      }
      runs[index] = {
        ...runs[index],
        ...patch,
        updated_at: "2026-04-09T00:01:00Z",
      };
      return runs[index];
    });
    return {
      listRecentRuns: () => runs,
      updateRun,
      appendEvent: vi.fn(),
      writeSummary: vi.fn(),
    };
  }

  it("refreshes matching recent run snapshots and preserves created_at", () => {
    const service = Object.create(PullRequestService.prototype) as PullRequestService;
    const runs = [makeRun()];
    const runStore = makeRunStoreStub(runs);
    (service as any).runStore = runStore;
    (service as any).now = () => "2026-04-09T00:02:00Z";

    const result = service.refreshPullRequestTruth({
      number: 70,
      url: "https://github.com/fusupo/escapement-studio/pull/70",
      title: "Refresh cached GitHub truth",
      body: "PR body",
      state: "MERGED",
      is_draft: false,
      base_ref: "develop",
      head_ref: "studio-91-branch",
      merged_at: "2026-04-09T00:00:30Z",
      merge_commit_sha: "abc123",
    }, { work_item_ids: ["studio-91"] });

    expect(result.updated_run_ids).toEqual(["exec_123"]);
    expect(runStore.updateRun).toHaveBeenCalledWith("exec_123", {
      pull_request: expect.objectContaining({
        number: 70,
        state: "MERGED",
        merged_at: "2026-04-09T00:00:30Z",
        merge_commit_sha: "abc123",
        created_at: "2026-04-09T00:00:00Z",
      }),
    });
    expect(runStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "exec_123" }),
      expect.objectContaining({ type: "pull_request_truth_refreshed" }),
    );
    expect(runStore.writeSummary).toHaveBeenCalledWith(expect.objectContaining({ run_id: "exec_123" }));
  });

  it("skips run updates when the stored truth already matches", () => {
    const service = Object.create(PullRequestService.prototype) as PullRequestService;
    const runs = [makeRun({
      pull_request: {
        number: 70,
        url: "https://github.com/fusupo/escapement-studio/pull/70",
        title: "Refresh cached GitHub truth",
        body: "PR body",
        base_ref: "develop",
        head_ref: "studio-91-branch",
        is_draft: false,
        created_at: "2026-04-09T00:00:00Z",
        state: "MERGED",
        merged_at: "2026-04-09T00:00:30Z",
        merge_commit_sha: "abc123",
      },
    })];
    const runStore = makeRunStoreStub(runs);
    (service as any).runStore = runStore;
    (service as any).now = () => "2026-04-09T00:02:00Z";

    const result = service.refreshPullRequestTruth({
      number: 70,
      url: "https://github.com/fusupo/escapement-studio/pull/70",
      title: "Refresh cached GitHub truth",
      body: "PR body",
      state: "MERGED",
      is_draft: false,
      base_ref: "develop",
      head_ref: "studio-91-branch",
      merged_at: "2026-04-09T00:00:30Z",
      merge_commit_sha: "abc123",
    }, { work_item_ids: ["studio-91"] });

    expect(result.updated_run_ids).toEqual([]);
    expect(runStore.updateRun).not.toHaveBeenCalled();
    expect(runStore.appendEvent).not.toHaveBeenCalled();
    expect(runStore.writeSummary).not.toHaveBeenCalled();
  });
});
