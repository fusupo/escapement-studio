import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../execution.service.js";
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

describe("ExecutionService.refreshPullRequestTruth", () => {
  it("refreshes matching recent run snapshots and preserves created_at", () => {
    const service = Object.create(ExecutionService.prototype) as ExecutionService;
    const runs = [makeRun()];
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

    (service as any).listRecentRuns = () => runs;
    (service as any).updateRun = updateRun;
    (service as any).appendEvent = vi.fn();
    (service as any).writeSummary = vi.fn();
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
    expect(updateRun).toHaveBeenCalledWith("exec_123", {
      pull_request: expect.objectContaining({
        number: 70,
        state: "MERGED",
        merged_at: "2026-04-09T00:00:30Z",
        merge_commit_sha: "abc123",
        created_at: "2026-04-09T00:00:00Z",
      }),
    });
    expect((service as any).appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "exec_123" }),
      expect.objectContaining({ type: "pull_request_truth_refreshed" }),
    );
    expect((service as any).writeSummary).toHaveBeenCalledWith(expect.objectContaining({ run_id: "exec_123" }));
  });

  it("skips run updates when the stored truth already matches", () => {
    const service = Object.create(ExecutionService.prototype) as ExecutionService;
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

    (service as any).listRecentRuns = () => runs;
    (service as any).updateRun = vi.fn();
    (service as any).appendEvent = vi.fn();
    (service as any).writeSummary = vi.fn();
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
    expect((service as any).updateRun).not.toHaveBeenCalled();
    expect((service as any).appendEvent).not.toHaveBeenCalled();
    expect((service as any).writeSummary).not.toHaveBeenCalled();
  });
});
