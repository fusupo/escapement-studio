import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { HsmActionHandlers } from "../hsm-action-handlers.js";
import type {
  HsmActionHandlerContext,
  WorkItemHsmEvent,
  WorkItemRecord,
} from "../../graph/types.js";

vi.mock("../run-archiver.js", () => ({
  archiveRunArtifactsForWorkItem: vi.fn(),
}));

import { archiveRunArtifactsForWorkItem } from "../run-archiver.js";

const archiveMock = vi.mocked(archiveRunArtifactsForWorkItem);

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-221",
    name: "Phase 1 HSM handler tests",
    kind: "issue",
    state: "merged_pr",
    repo: "fusupo/escapement-studio",
    issue_number: 221,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/221",
    scope_hint: null,
    branch: "221-phase-1",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-12T00:00:00.000Z",
    ...overrides,
  } as WorkItemRecord;
}

function makeContext(): HsmActionHandlerContext {
  return {
    meta: {},
    handler_data: {},
    patch_overrides: {},
  };
}

const finalizeEvent: WorkItemHsmEvent = { type: "user.finalize" };
const archiveEvent: WorkItemHsmEvent = { type: "user.archive_and_finalize" };

describe("HsmActionHandlers (execution module)", () => {
  describe("registration on bootstrap", () => {
    it("registers closeGhIssue and runArchiver against WorkItemHsmService", () => {
      // The whole point of moving this class out of the inline closures:
      // a plain unit test can prove the wiring without booting Nest. If a
      // future refactor breaks the registration, this test catches it.
      const registerActionHandler = vi.fn();
      const hsm = { registerActionHandler } as never;
      const handlers = new HsmActionHandlers(hsm, {} as never, {} as never);

      handlers.onModuleInit();

      expect(registerActionHandler).toHaveBeenCalledTimes(2);
      expect(registerActionHandler).toHaveBeenNthCalledWith(
        1,
        "closeGhIssue",
        expect.any(Function),
      );
      expect(registerActionHandler).toHaveBeenNthCalledWith(
        2,
        "runArchiver",
        expect.any(Function),
      );
    });
  });

  describe("closeGhIssue", () => {
    it("closes the issue and surfaces the closed-issue details on handler_data", async () => {
      const closeIssue = vi.fn(async () => ({
        repo: "fusupo/escapement-studio",
        number: 221,
        url: "https://github.com/fusupo/escapement-studio/issues/221",
        title: "Phase 1",
        state: "closed",
      }));
      const github = { closeIssue } as never;
      const handlers = new HsmActionHandlers({} as never, github, {} as never);
      const ctx = makeContext();

      await handlers.closeGhIssue(makeWorkItem(), finalizeEvent, ctx);

      expect(closeIssue).toHaveBeenCalledWith("fusupo/escapement-studio", 221);
      expect(ctx.handler_data.closed_issue).toEqual({
        repo: "fusupo/escapement-studio",
        number: 221,
        url: "https://github.com/fusupo/escapement-studio/issues/221",
        title: "Phase 1",
        state: "closed",
      });
    });

    it("is a no-op for non-issue work items", async () => {
      const closeIssue = vi.fn();
      const github = { closeIssue } as never;
      const handlers = new HsmActionHandlers({} as never, github, {} as never);
      const ctx = makeContext();

      await handlers.closeGhIssue(
        makeWorkItem({ kind: "capability" }),
        finalizeEvent,
        ctx,
      );

      expect(closeIssue).not.toHaveBeenCalled();
      expect(ctx.handler_data).toEqual({});
    });

    it("wraps GitHub failures in BadRequestException with a stable error code", async () => {
      const closeIssue = vi.fn(async () => {
        throw new Error("network unreachable");
      });
      const github = { closeIssue } as never;
      const handlers = new HsmActionHandlers({} as never, github, {} as never);

      await expect(
        handlers.closeGhIssue(makeWorkItem(), finalizeEvent, makeContext()),
      ).rejects.toThrow(BadRequestException);
      await expect(
        handlers.closeGhIssue(makeWorkItem(), finalizeEvent, makeContext()),
      ).rejects.toThrow(/close_merged_failed_github_close: network unreachable/);
    });
  });

  describe("runArchiver", () => {
    function makeExecutionMock() {
      return {
        captureRunSnapshotForWorkItem: vi.fn(() => []),
        movePlanDirToArchives: vi.fn(() => ({
          moved: true,
          archive_path: "/tmp/studio-archive/studio-221",
        })),
        getArtifactRoot: vi.fn(() => "/tmp/studio-artifact-root"),
        logWarn: vi.fn(),
      };
    }

    it("snapshots runs, moves the plan dir, archives, and stamps studio_archive meta", async () => {
      const execution = makeExecutionMock();
      archiveMock.mockReturnValue({
        work_item_id: "studio-221",
        archive_path: "/tmp/studio-archive/studio-221",
        readme_path: "/tmp/studio-archive/studio-221/README.md",
        archived_run_ids: ["exec_42"],
        skipped_run_ids: [],
      });
      const handlers = new HsmActionHandlers(
        {} as never,
        {} as never,
        execution as never,
      );
      const ctx = makeContext();

      await handlers.runArchiver(
        makeWorkItem({ state: "merged_pr" }),
        archiveEvent,
        ctx,
      );

      expect(execution.captureRunSnapshotForWorkItem).toHaveBeenCalledWith("studio-221");
      expect(execution.movePlanDirToArchives).toHaveBeenCalledWith("studio-221");
      expect(archiveMock).toHaveBeenCalledTimes(1);
      expect(ctx.meta.studio_archive).toMatchObject({
        readme_path: "/tmp/studio-archive/studio-221/README.md",
        archived_run_ids: ["exec_42"],
        skipped_run_ids: [],
      });
      expect(ctx.patch_overrides.archive_path).toBe("/tmp/studio-archive/studio-221");
      expect(ctx.handler_data.archive_result).toMatchObject({
        archive_path: "/tmp/studio-archive/studio-221",
        archived_run_ids: ["exec_42"],
      });
    });

    it("translates archive_run_active errors into BadRequestException", async () => {
      const execution = makeExecutionMock();
      archiveMock.mockImplementation(() => {
        throw new Error("archive_run_active: run exec_99 still active");
      });
      const handlers = new HsmActionHandlers(
        {} as never,
        {} as never,
        execution as never,
      );

      await expect(
        handlers.runArchiver(makeWorkItem(), archiveEvent, makeContext()),
      ).rejects.toThrow(BadRequestException);
    });

    it("propagates unrelated errors unchanged", async () => {
      const execution = makeExecutionMock();
      archiveMock.mockImplementation(() => {
        throw new Error("disk full");
      });
      const handlers = new HsmActionHandlers(
        {} as never,
        {} as never,
        execution as never,
      );

      await expect(
        handlers.runArchiver(makeWorkItem(), archiveEvent, makeContext()),
      ).rejects.toThrow(/^disk full$/);
    });
  });
});
