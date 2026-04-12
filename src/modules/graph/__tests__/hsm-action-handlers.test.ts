import { describe, expect, it, vi } from "vitest";
import { HsmActionHandlers } from "../hsm-action-handlers.js";
import { HsmGuardHandlers } from "../hsm-guard-handlers.js";
import type { WorkItemRecord } from "../types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-202",
    name: "HSM handler tests",
    kind: "issue",
    state: "ready",
    repo: "fusupo/escapement-studio",
    issue_number: 202,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/202",
    scope_hint: null,
    branch: "studio-202-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

const now = () => "2026-04-12T12:00:00.000Z";

describe("HsmActionHandlers", () => {
  it("createRunRecord persists a run and returns the run id", async () => {
    const executionService = {
      createHsmRunRecord: vi.fn(() => ({ run_id: "exec_123", branch: "studio-202-branch", base_ref: "develop" })),
      archiveRunArtifacts: vi.fn(),
    };
    const githubService = { readIssue: vi.fn(), closeIssue: vi.fn() };
    const cache = { upsertIssue: vi.fn() };
    const handlers = new HsmActionHandlers(executionService as never, githubService as never, cache as never);

    const result = await handlers.createRunRecord({
      workItem: makeWorkItem(),
      event: { type: "user.dispatch" },
      now,
    });

    expect(executionService.createHsmRunRecord).toHaveBeenCalled();
    expect(result.output).toEqual({ run_id: "exec_123" });
    expect(result.patch?.meta).toHaveProperty("studio_dispatch_run");
  });

  it("stampMeta copies the event payload into the named block", async () => {
    const handlers = new HsmActionHandlers({} as never, {} as never, {} as never);
    const action = handlers.stampMeta("studio_post_merge_sync");

    const result = await action({
      workItem: makeWorkItem({ state: "open_pr" }),
      event: { type: "gh.pr_merged", payload: { pull_request: { number: 202 } } },
      now,
    });

    expect(result.patch?.meta).toMatchObject({
      studio_post_merge_sync: {
        at: "2026-04-12T12:00:00.000Z",
        pull_request: { number: 202 },
      },
    });
  });

  it("closeGhIssue is idempotent when the issue is already closed", async () => {
    const executionService = { createHsmRunRecord: vi.fn(), archiveRunArtifacts: vi.fn() };
    const githubService = {
      readIssue: vi.fn(async () => ({ number: 202, url: "https://example.test/issues/202", title: "Issue", state: "CLOSED" })),
      closeIssue: vi.fn(),
    };
    const cache = { upsertIssue: vi.fn() };
    const handlers = new HsmActionHandlers(executionService as never, githubService as never, cache as never);

    const result = await handlers.closeGhIssue({
      workItem: makeWorkItem({ state: "merged_pr" }),
      event: { type: "user.finalize" },
      now,
    });

    expect(githubService.closeIssue).not.toHaveBeenCalled();
    expect(cache.upsertIssue).toHaveBeenCalledWith("fusupo/escapement-studio", expect.objectContaining({ number: 202, state: "closed" }));
    expect(result.patch?.meta).toHaveProperty("studio_issue_close_sync");
  });

  it("runArchiver writes archive_path from the existing run archiver", async () => {
    const executionService = {
      createHsmRunRecord: vi.fn(),
      archiveRunArtifacts: vi.fn(() => ({ archive_path: "/tmp/archive/studio-202", archived_run_ids: ["exec_1"] })),
    };
    const handlers = new HsmActionHandlers(executionService as never, {} as never, {} as never);

    const result = await handlers.runArchiver({
      workItem: makeWorkItem({ state: "closed" }),
      event: { type: "user.archive_and_finalize" },
      now,
    });

    expect(executionService.archiveRunArtifacts).toHaveBeenCalledWith("studio-202");
    expect(result.patch).toMatchObject({ archive_path: "/tmp/archive/studio-202" });
  });
});

describe("HsmGuardHandlers", () => {
  it("returns true when the branch has a cached pull request", async () => {
    const cache = {
      findPullRequestForBranch: vi.fn(async () => ({ number: 202 })),
    };
    const guards = new HsmGuardHandlers(cache as never);

    await expect(guards.prExistsForBranch({
      workItem: makeWorkItem({ state: "in_progress" }),
      event: { type: "run.completed" },
      now,
    })).resolves.toBe(true);
  });

  it("returns false when repo or branch is missing", async () => {
    const cache = {
      findPullRequestForBranch: vi.fn(),
    };
    const guards = new HsmGuardHandlers(cache as never);

    await expect(guards.prExistsForBranch({
      workItem: makeWorkItem({ repo: null, branch: null }),
      event: { type: "run.completed" },
      now,
    })).resolves.toBe(false);
    expect(cache.findPullRequestForBranch).not.toHaveBeenCalled();
  });
});
