import { describe, expect, it, vi } from "vitest";
import { HsmActionHandlers } from "../hsm-action-handlers.js";
import { HsmGuardHandlers } from "../hsm-guard-handlers.js";
import type { WorkItemRecord } from "../types.js";

vi.mock("../../../lib/github-cli.js", () => ({
  fetchIssueBody: vi.fn(() => "Mocked issue body from HSM handler test."),
}));

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

function makeDraftEnvelope() {
  return {
    summary: "Drafted summary",
    acceptance_criteria: ["Criterion A"],
    implementation_tasks: [
      {
        description: "Task 1",
        files: ["src/foo.ts"],
        rationale: "why",
        testing: "test it",
      },
    ],
    affected_files: ["src/foo.ts"],
    questions: [],
    assumptions: [],
    blockers: [],
    technical_notes: {
      architecture: "arch",
      approach: "approach",
      challenges: "challenges",
    },
  };
}

describe("HsmActionHandlers", () => {
  it("createRunRecord persists a run and returns the run id", async () => {
    const executionService = {
      createHsmRunRecord: vi.fn(() => ({ run_id: "exec_123", branch: "studio-202-branch", base_ref: "develop" })),
      archiveRunArtifacts: vi.fn(),
    };
    const githubService = { readIssue: vi.fn(), closeIssue: vi.fn() };
    const cache = { upsertIssue: vi.fn() };
    const handlers = new HsmActionHandlers(
      executionService as never,
      githubService as never,
      cache as never,
      {} as never,
      {} as never,
    );

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
    const handlers = new HsmActionHandlers({} as never, {} as never, {} as never, {} as never, {} as never);
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
    const handlers = new HsmActionHandlers(
      executionService as never,
      githubService as never,
      cache as never,
      {} as never,
      {} as never,
    );

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
    const handlers = new HsmActionHandlers(executionService as never, {} as never, {} as never, {} as never, {} as never);

    const result = await handlers.runArchiver({
      workItem: makeWorkItem({ state: "closed" }),
      event: { type: "user.archive_and_finalize" },
      now,
    });

    expect(executionService.archiveRunArtifacts).toHaveBeenCalledWith("studio-202");
    expect(result.patch).toMatchObject({ archive_path: "/tmp/archive/studio-202" });
  });

  it("kickOffPlanDrafter waits for persistDraftEnvelope before completion resolves", async () => {
    let resolvePersist: undefined | (() => void);
    const persistDraftEnvelope = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const drafter = {
      startDraft: vi.fn(() => ({
        sessionId: "draft-session-1",
        completion: Promise.resolve(makeDraftEnvelope()),
        cancel: vi.fn(),
      })),
    };
    const handlers = new HsmActionHandlers(
      {} as never,
      {} as never,
      {} as never,
      drafter as never,
      { persistDraftEnvelope } as never,
    );

    const handle = handlers.kickOffPlanDrafter({
      workItem: makeWorkItem({ state: "drafting" }),
      event: { type: "user.start_draft" },
      now,
    });

    let completed = false;
    const completion = handle.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(persistDraftEnvelope).toHaveBeenCalledWith(
      "studio-202",
      expect.objectContaining({ summary: "Drafted summary" }),
      "Mocked issue body from HSM handler test.",
      { transitionToDrafting: false },
    );
    expect(completed).toBe(false);

    expect(resolvePersist).toBeTypeOf("function");
    resolvePersist?.();
    await completion;
    expect(completed).toBe(true);
  });

  it("kickOffPlanDrafter propagates persistDraftEnvelope failures", async () => {
    const drafter = {
      startDraft: vi.fn(() => ({
        sessionId: "draft-session-1",
        completion: Promise.resolve(makeDraftEnvelope()),
        cancel: vi.fn(),
      })),
    };
    const handlers = new HsmActionHandlers(
      {} as never,
      {} as never,
      {} as never,
      drafter as never,
      {
        persistDraftEnvelope: vi.fn(async () => {
          throw new Error("persist failed");
        }),
      } as never,
    );

    const handle = handlers.kickOffPlanDrafter({
      workItem: makeWorkItem({ state: "drafting" }),
      event: { type: "user.start_draft" },
      now,
    });

    await expect(handle.completion).rejects.toThrow("persist failed");
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
