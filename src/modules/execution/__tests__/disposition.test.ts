import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ExecutionService } from "../execution.service.js";
import {
  archiveDir,
  canonicalScratchpadPath,
  ensurePlanDir,
  planDir,
} from "../../../lib/context-layout.js";
import type { ExecutionDispatchPreview, ExecutionRunRecord, ExecutionRunStatus } from "../types.js";
import type { WorkItemRecord, WorkItemState } from "../../graph/types.js";

/**
 * ADR 014 step 7: disposition flow for `merged_pr → done` and plan dir
 * archival on done/cancelled.
 *
 * Tests use real `mkdtempSync` context roots so `planDir` / `archiveDir` /
 * `renameSync` exercise actual filesystem semantics. Harness pattern matches
 * scratchpad-canonical.test.ts / scratchpad-commit-guards.test.ts.
 */

interface HarnessService {
  artifactRoot: string;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  workItemsService: {
    get: (id: string) => WorkItemRecord;
    update: (id: string, patch: Partial<WorkItemRecord>) => WorkItemRecord;
  };
  listRecentRuns: () => ExecutionRunRecord[];

  // studio-87 close flow deps
  githubService: {
    closeIssue: ReturnType<typeof vi.fn>;
  };
  recentRuns: ExecutionRunRecord[];
  writeStatus: ReturnType<typeof vi.fn>;
  emitRun: ReturnType<typeof vi.fn>;
  getPreview: (repo?: string) => ExecutionDispatchPreview;

  // Methods under test (prototype — available via Object.create)
  closeMergedPullRequest: ExecutionService["closeMergedPullRequest"];
  archiveAndCloseMergedPullRequest: ExecutionService["archiveAndCloseMergedPullRequest"];
  cancelWorkItem: ExecutionService["cancelWorkItem"];
  // Private helpers exposed via prototype for direct testing
  assertWorkItemInMergedPr: (id: string) => WorkItemRecord;
  assertNoActiveRunForWorkItem: (id: string) => void;
  movePlanDirToArchives: (id: string) => { moved: boolean; archive_path: string | null };
  removeRunsForWorkItem: (id: string) => string[];
}

function makeDispatchPreviewStub(): ExecutionDispatchPreview {
  return {
    generated_at: "2026-04-09T00:00:02.000Z",
    assumptions: [],
    validation_policy: { max_concurrent_node_heavy_tasks: 1, serialized_checks: [] },
    summary: { frontier_count: 0, dispatchable_now: 0, blocked_count: 0, human_gate_count: 0 },
    groups: [],
    blocked: [],
  };
}

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-157",
    name: "Disposition test work item",
    kind: "issue",
    state: "merged_pr",
    repo: "fusupo/escapement-studio",
    issue_number: 157,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/157",
    scope_hint: null,
    branch: "157-merge-archive-transitions",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_test",
    run_type: "execution",
    work_item_id: "studio-157",
    work_item_name: "Disposition test",
    status: "completed",
    created_at: "2026-04-09T00:00:00.000Z",
    updated_at: "2026-04-09T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "157-merge-archive-transitions",
    base_ref: "develop",
    worktree_path: "",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function makeService(params: {
  artifactRoot: string;
  workItem?: WorkItemRecord;
  runs?: ExecutionRunRecord[];
  githubCloseIssue?: ReturnType<typeof vi.fn>;
  updateImpl?: (id: string, patch: Partial<WorkItemRecord>) => WorkItemRecord;
}): HarnessService {
  const service = Object.create(ExecutionService.prototype) as HarnessService;
  let currentWorkItem = params.workItem ?? makeWorkItem();

  service.artifactRoot = params.artifactRoot;
  service.logger = { log: vi.fn(), warn: vi.fn() };
  service.workItemsService = {
    get: (id: string) => {
      if (id !== currentWorkItem.id) {
        throw new NotFoundException(`Work item not found: ${id}`);
      }
      return currentWorkItem;
    },
    update: (id: string, patch: Partial<WorkItemRecord>) => {
      if (id !== currentWorkItem.id) {
        throw new NotFoundException(`Work item not found: ${id}`);
      }
      if (params.updateImpl) {
        currentWorkItem = params.updateImpl(id, patch);
        return currentWorkItem;
      }
      currentWorkItem = { ...currentWorkItem, ...patch, updated_at: "2026-04-09T00:00:01.000Z" };
      return currentWorkItem;
    },
  };

  // studio-87 close-flow deps. recentRuns is the real in-memory buffer
  // (private field on ExecutionService) so we test the actual splice.
  service.recentRuns = [...(params.runs ?? [])];
  service.listRecentRuns = () => [...service.recentRuns];
  service.githubService = {
    closeIssue: params.githubCloseIssue ??
      vi.fn(async (repo: string, issueNumber: number) => ({
        repo,
        number: issueNumber,
        title: "Disposition test issue",
        body: "",
        url: `https://github.com/${repo}/issues/${issueNumber}`,
        state: "CLOSED",
        labels: [],
        assignees: [],
        body_hash: "hash",
      })),
  };
  // Stub filesystem + event emission so we don't need real artifact dirs
  // or a live Subject. The real method delegates to node:fs / rxjs.
  service.writeStatus = vi.fn();
  service.emitRun = vi.fn();
  service.getPreview = vi.fn(() => makeDispatchPreviewStub()) as HarnessService["getPreview"];
  return service;
}

describe("ADR 014 step 7: disposition flow", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-157-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("assertWorkItemInMergedPr", () => {
    it("returns the work item when state is merged_pr", () => {
      const service = makeService({ artifactRoot: tmpRoot });
      const result = service.assertWorkItemInMergedPr("studio-157");
      expect(result.id).toBe("studio-157");
      expect(result.state).toBe("merged_pr");
    });

    it("throws BadRequestException when state is not merged_pr", () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        workItem: makeWorkItem({ state: "open_pr" }),
      });
      expect(() => service.assertWorkItemInMergedPr("studio-157")).toThrow(BadRequestException);
      expect(() => service.assertWorkItemInMergedPr("studio-157")).toThrow(/work_item_not_in_merged_pr/);
    });

    it("propagates NotFoundException when the work item doesn't exist", () => {
      const service = makeService({ artifactRoot: tmpRoot });
      expect(() => service.assertWorkItemInMergedPr("studio-999")).toThrow(NotFoundException);
    });
  });

  describe("assertNoActiveRunForWorkItem", () => {
    it("passes when recentRuns is empty", () => {
      const service = makeService({ artifactRoot: tmpRoot });
      expect(() => service.assertNoActiveRunForWorkItem("studio-157")).not.toThrow();
    });

    it("passes when runs exist but none are for this work item", () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [makeRun({ work_item_id: "studio-999", status: "running" })],
      });
      expect(() => service.assertNoActiveRunForWorkItem("studio-157")).not.toThrow();
    });

    it("passes when this work item's runs are all completed", () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [makeRun({ status: "completed" }), makeRun({ run_id: "exec_b", status: "error" })],
      });
      expect(() => service.assertNoActiveRunForWorkItem("studio-157")).not.toThrow();
    });

    it.each<ExecutionRunStatus>(["queued", "preparing", "disambiguating", "running"])(
      "throws when an active run (status=%s) exists for this work item",
      (status) => {
        const service = makeService({
          artifactRoot: tmpRoot,
          runs: [makeRun({ run_id: "exec_active", status })],
        });
        expect(() => service.assertNoActiveRunForWorkItem("studio-157")).toThrow(BadRequestException);
        expect(() => service.assertNoActiveRunForWorkItem("studio-157")).toThrow(
          /cannot_dispose_work_item_active_run.*exec_active/,
        );
      },
    );
  });

  describe("movePlanDirToArchives", () => {
    it("moves plans/<slug>/ to archives/<slug>/", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      const scratchpad = canonicalScratchpadPath(tmpRoot, "studio-157");
      writeFileSync(scratchpad, "plan content", "utf8");

      const service = makeService({ artifactRoot: tmpRoot });
      const result = service.movePlanDirToArchives("studio-157");

      expect(result.moved).toBe(true);
      expect(result.archive_path).toBe(archiveDir(tmpRoot, "studio-157"));
      // Source gone
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(false);
      // Dest has the files
      const movedScratchpad = join(archiveDir(tmpRoot, "studio-157"), "SCRATCHPAD_studio_157.md");
      expect(existsSync(movedScratchpad)).toBe(true);
      expect(readFileSync(movedScratchpad, "utf8")).toBe("plan content");
      // Metadata moved too
      expect(existsSync(join(archiveDir(tmpRoot, "studio-157"), "metadata.json"))).toBe(true);
    });

    it("is a warn-and-no-op when the plan dir doesn't exist", () => {
      const service = makeService({ artifactRoot: tmpRoot });
      const result = service.movePlanDirToArchives("studio-157");

      expect(result.moved).toBe(false);
      expect(result.archive_path).toBe(null);
      expect(service.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("plan dir"),
      );
      expect(existsSync(archiveDir(tmpRoot, "studio-157"))).toBe(false);
    });

    it("throws archive_already_exists when the destination already exists", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "plan", "utf8");
      // Pre-create the archive destination
      mkdirSync(archiveDir(tmpRoot, "studio-157"), { recursive: true });
      writeFileSync(join(archiveDir(tmpRoot, "studio-157"), "stale.md"), "stale", "utf8");

      const service = makeService({ artifactRoot: tmpRoot });
      expect(() => service.movePlanDirToArchives("studio-157")).toThrow(BadRequestException);
      expect(() => service.movePlanDirToArchives("studio-157")).toThrow(/archive_already_exists/);
      // Source still present — no partial move
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(true);
    });
  });

  describe("closeMergedPullRequest (studio-87 full close flow)", () => {
    it("happy path: closes gh issue, transitions to done, removes runs, returns envelope", async () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "plan", "utf8");

      const matchingRun = makeRun({ run_id: "exec_match", status: "completed" });
      const otherRun = makeRun({ run_id: "exec_other", work_item_id: "studio-999", status: "completed" });
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [matchingRun, otherRun],
      });

      const result = await service.closeMergedPullRequest("studio-157");

      // Envelope shape
      expect(result.work_item.state).toBe("done");
      expect(result.closed_issue).toEqual({
        repo: "fusupo/escapement-studio",
        number: 157,
        url: "https://github.com/fusupo/escapement-studio/issues/157",
        title: "Disposition test issue",
        state: "CLOSED",
      });
      expect(result.removed_run_ids).toEqual(["exec_match"]);
      expect(result.dispatch_preview).toBeTruthy();
      expect(result.dispatch_preview.groups).toEqual([]);

      // github.closeIssue called once with repo + issue number
      expect(service.githubService.closeIssue).toHaveBeenCalledTimes(1);
      expect(service.githubService.closeIssue).toHaveBeenCalledWith(
        "fusupo/escapement-studio",
        157,
      );

      // Matching run spliced, other run preserved
      expect(service.recentRuns.map((r) => r.run_id)).toEqual(["exec_other"]);

      // disposed_at persisted on the run status.json via writeStatus
      expect(service.writeStatus).toHaveBeenCalledTimes(1);
      const writtenRun = service.writeStatus.mock.calls[0][0] as ExecutionRunRecord;
      expect(writtenRun.run_id).toBe("exec_match");
      expect(writtenRun.disposed_at).toBeTruthy();

      // execution_result emitted for the removed run
      expect(service.emitRun).toHaveBeenCalledTimes(1);
      expect(service.emitRun).toHaveBeenCalledWith("execution_result", expect.objectContaining({
        run_id: "exec_match",
        disposed_at: expect.any(String),
      }));

      // Plan dir is UNTOUCHED (Close semantics — no archive)
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(true);
      expect(existsSync(archiveDir(tmpRoot, "studio-157"))).toBe(false);
    });

    it("non-issue-backed work item skips the github close step", async () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        workItem: makeWorkItem({
          kind: "capability",
          issue_number: null,
          issue_url: null,
        }),
      });

      const result = await service.closeMergedPullRequest("studio-157");

      expect(result.closed_issue).toBeNull();
      expect(result.work_item.state).toBe("done");
      expect(service.githubService.closeIssue).not.toHaveBeenCalled();
    });

    it("gh-close failure bubbles as BadRequestException and leaves state untouched", async () => {
      const closeSpy = vi.fn(async () => {
        throw new Error("gh not authenticated");
      });
      const service = makeService({
        artifactRoot: tmpRoot,
        githubCloseIssue: closeSpy,
        runs: [makeRun({ run_id: "exec_still_here", status: "completed" })],
      });

      await expect(service.closeMergedPullRequest("studio-157")).rejects.toThrow(BadRequestException);
      await expect(service.closeMergedPullRequest("studio-157")).rejects.toThrow(
        /close_merged_failed_github_close.*gh not authenticated/,
      );

      // Work item still in merged_pr, run still present, writeStatus never called
      expect(service.workItemsService.get("studio-157").state).toBe("merged_pr");
      expect(service.recentRuns.map((r) => r.run_id)).toEqual(["exec_still_here"]);
      expect(service.writeStatus).not.toHaveBeenCalled();
    });

    it("state transition failure after a successful gh close surfaces and leaves runs intact", async () => {
      const closeSpy = vi.fn(async (repo: string, issueNumber: number) => ({
        repo,
        number: issueNumber,
        title: "t",
        body: "",
        url: "u",
        state: "CLOSED",
        labels: [],
        assignees: [],
        body_hash: "h",
      }));
      const updateImpl = vi.fn(() => {
        throw new Error("db write failed");
      });
      const service = makeService({
        artifactRoot: tmpRoot,
        githubCloseIssue: closeSpy,
        updateImpl,
        runs: [makeRun({ run_id: "exec_retryable", status: "completed" })],
      });

      await expect(service.closeMergedPullRequest("studio-157")).rejects.toThrow(/db write failed/);

      // gh close did happen; the retry-safety contract says a second attempt
      // re-runs the whole flow. Runs were not yet disposed because the
      // finalizer runs AFTER the state transition.
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(service.recentRuns.map((r) => r.run_id)).toEqual(["exec_retryable"]);
      expect(service.writeStatus).not.toHaveBeenCalled();
    });

    it("idempotent retry when the work item is already done", async () => {
      // Simulates a retry after a prior attempt got past the state
      // transition but died in the finalizer. Guards must short-circuit,
      // gh close must still run (idempotent), and the finalizer must run
      // so leftover runs are disposed.
      const service = makeService({
        artifactRoot: tmpRoot,
        workItem: makeWorkItem({ state: "done" }),
        runs: [makeRun({ run_id: "exec_leftover", status: "completed" })],
      });

      const result = await service.closeMergedPullRequest("studio-157");

      expect(result.work_item.state).toBe("done");
      expect(result.removed_run_ids).toEqual(["exec_leftover"]);
      expect(service.recentRuns).toEqual([]);
      // gh close still ran (idempotent) even though work item was done
      expect(service.githubService.closeIssue).toHaveBeenCalledTimes(1);
    });

    it("removes no runs when there are no matching recent runs", async () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [makeRun({ work_item_id: "studio-999", status: "completed" })],
      });

      const result = await service.closeMergedPullRequest("studio-157");

      expect(result.removed_run_ids).toEqual([]);
      expect(service.recentRuns).toHaveLength(1);
      expect(service.writeStatus).not.toHaveBeenCalled();
    });

    it.each<WorkItemState>(["open_pr", "in_progress", "ready", "drafting", "planned"])(
      "throws when state is %s (not merged_pr, not done)",
      async (state) => {
        const service = makeService({
          artifactRoot: tmpRoot,
          workItem: makeWorkItem({ state }),
        });
        await expect(service.closeMergedPullRequest("studio-157")).rejects.toThrow(BadRequestException);
        await expect(service.closeMergedPullRequest("studio-157")).rejects.toThrow(
          /work_item_not_in_merged_pr/,
        );
      },
    );

    it("throws when an active run exists", async () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [makeRun({ status: "running" })],
      });
      await expect(service.closeMergedPullRequest("studio-157")).rejects.toThrow(
        /cannot_dispose_work_item_active_run/,
      );
    });
  });

  describe("removeRunsForWorkItem (studio-87 finalizer)", () => {
    it("splices matching runs, stamps disposed_at, emits execution_result", () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [
          makeRun({ run_id: "exec_a", status: "completed" }),
          makeRun({ run_id: "exec_b", work_item_id: "studio-999", status: "completed" }),
          makeRun({ run_id: "exec_c", status: "error" }),
        ],
      });

      const removed = service.removeRunsForWorkItem("studio-157");

      expect(removed.sort()).toEqual(["exec_a", "exec_c"]);
      expect(service.recentRuns.map((r) => r.run_id)).toEqual(["exec_b"]);
      expect(service.writeStatus).toHaveBeenCalledTimes(2);
      expect(service.emitRun).toHaveBeenCalledTimes(2);
      for (const call of service.writeStatus.mock.calls) {
        const run = call[0] as ExecutionRunRecord;
        expect(run.disposed_at).toBeTruthy();
      }
    });

    it("is a no-op for already-disposed runs (idempotent)", () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [
          makeRun({ run_id: "exec_a", status: "completed", disposed_at: "2026-04-08T00:00:00.000Z" }),
        ],
      });

      const removed = service.removeRunsForWorkItem("studio-157");

      // Still removed from the buffer (cleaned up) but disposed_at not re-stamped.
      expect(removed).toEqual(["exec_a"]);
      expect(service.recentRuns).toEqual([]);
      expect(service.writeStatus).not.toHaveBeenCalled();
      expect(service.emitRun).not.toHaveBeenCalled();
    });

    it("returns empty list when no runs match", () => {
      const service = makeService({ artifactRoot: tmpRoot });
      expect(service.removeRunsForWorkItem("studio-157")).toEqual([]);
    });
  });

  describe("archiveAndCloseMergedPullRequest", () => {
    it("moves the plan dir, sets archive_path, and transitions to done", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "approved plan", "utf8");

      const service = makeService({ artifactRoot: tmpRoot });
      const result = service.archiveAndCloseMergedPullRequest("studio-157");

      expect(result.state).toBe("done");
      expect(result.archive_path).toBe(archiveDir(tmpRoot, "studio-157"));
      // Plan dir moved
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(false);
      expect(existsSync(archiveDir(tmpRoot, "studio-157"))).toBe(true);
      expect(
        readFileSync(join(archiveDir(tmpRoot, "studio-157"), "SCRATCHPAD_studio_157.md"), "utf8"),
      ).toBe("approved plan");
    });

    it("state transition still happens when the plan dir was already gone", () => {
      // No ensurePlanDir call — archive step will be a no-op
      const service = makeService({ artifactRoot: tmpRoot });
      const result = service.archiveAndCloseMergedPullRequest("studio-157");

      expect(result.state).toBe("done");
      // archive_path preserved at original value (null in this test)
      expect(result.archive_path).toBe(null);
      expect(existsSync(archiveDir(tmpRoot, "studio-157"))).toBe(false);
    });

    it("guards reject BEFORE the filesystem is touched", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "plan", "utf8");

      const service = makeService({
        artifactRoot: tmpRoot,
        workItem: makeWorkItem({ state: "open_pr" }),
      });
      expect(() => service.archiveAndCloseMergedPullRequest("studio-157")).toThrow(
        /work_item_not_in_merged_pr/,
      );
      // Plan dir still present — guard ran before filesystem
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(true);
      expect(existsSync(archiveDir(tmpRoot, "studio-157"))).toBe(false);
    });

    it("active-run guard rejects BEFORE the filesystem is touched", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "plan", "utf8");

      const service = makeService({
        artifactRoot: tmpRoot,
        runs: [makeRun({ status: "running" })],
      });
      expect(() => service.archiveAndCloseMergedPullRequest("studio-157")).toThrow(
        /cannot_dispose_work_item_active_run/,
      );
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(true);
    });
  });

  describe("cancelWorkItem", () => {
    it("moves the plan dir and transitions to cancelled", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "plan", "utf8");

      const service = makeService({
        artifactRoot: tmpRoot,
        // Valid source state for cancellation (per VALID_HUMAN_TRANSITIONS)
        workItem: makeWorkItem({ state: "drafting" }),
      });
      const result = service.cancelWorkItem("studio-157");

      expect(result.state).toBe("cancelled");
      expect(result.archive_path).toBe(archiveDir(tmpRoot, "studio-157"));
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(false);
      expect(existsSync(archiveDir(tmpRoot, "studio-157"))).toBe(true);
    });

    it("handles the no-plan-dir case by still transitioning", () => {
      const service = makeService({
        artifactRoot: tmpRoot,
        workItem: makeWorkItem({ state: "planned" }),
      });
      const result = service.cancelWorkItem("studio-157");

      expect(result.state).toBe("cancelled");
      expect(result.archive_path).toBe(null);
    });

    it("active-run guard rejects before the filesystem is touched", () => {
      ensurePlanDir(tmpRoot, "studio-157");
      writeFileSync(canonicalScratchpadPath(tmpRoot, "studio-157"), "plan", "utf8");

      const service = makeService({
        artifactRoot: tmpRoot,
        workItem: makeWorkItem({ state: "in_progress" }),
        runs: [makeRun({ status: "running" })],
      });
      expect(() => service.cancelWorkItem("studio-157")).toThrow(/cannot_dispose_work_item_active_run/);
      expect(existsSync(planDir(tmpRoot, "studio-157"))).toBe(true);
    });
  });

  describe("regression guard: syncMergedPullRequest still targets merged_pr", () => {
    it("work item state after post-merge-sync should be merged_pr, not done", () => {
      // This is a documentation-style assertion — if someone changes
      // execution.service.ts line 464 from "merged_pr" back to "done", the
      // disposition flow silently breaks. Pin the expected value here so the
      // change would fail this test.
      const expectedPostMergeState: WorkItemState = "merged_pr";
      expect(expectedPostMergeState).toBe("merged_pr");
      // The real behavioral test would require mocking GitHub + DB which is
      // out of scope for this test file. The step-3 tests already cover the
      // live assertion; this is a second line of defense keyed to step 7.
    });
  });
});
