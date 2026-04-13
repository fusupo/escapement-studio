import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

/**
 * ADR 014 step 6: scratchpad commit guards.
 *
 * These tests focus on guard behavior, not the OS process boundary.
 * The service methods already centralize git access through `runGitIn()`,
 * so the test harness stubs command output instead of shelling out to a
 * real `git` binary. That keeps the assertions deterministic and avoids
 * sandbox-related child-process failures.
 */

interface HarnessService {
  artifactRoot: string;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  workItemsService: { get: (id: string) => WorkItemRecord; update: ReturnType<typeof vi.fn> };
  // Phase 4a: appendEvent, updateRun, getRun, writeSummary moved to RunStore.
  runStore: {
    appendEvent: ReturnType<typeof vi.fn>;
    updateRun: ReturnType<typeof vi.fn>;
    getRun: (runId: string) => ExecutionRunRecord | null;
    writeSummary: ReturnType<typeof vi.fn>;
  };
  // Phase 4b (#231): runGhIn / runGitIn / listChangedFiles moved to
  // WorktreeService. The harness installs a worktreeService field with
  // all three stubbed so the scratchpad commit guards (still on
  // ExecutionService.prototype) can reach them via
  // `this.worktreeService.runGitIn(...)`.
  worktreeService: {
    runGhIn: ReturnType<typeof vi.fn>;
    runGitIn: ReturnType<typeof vi.fn>;
    listChangedFiles: ReturnType<typeof vi.fn>;
  };
  buildPullRequestTitle: (workItem: WorkItemRecord) => string;
  buildPullRequestBody: (run: ExecutionRunRecord, workItem: WorkItemRecord, baseRef: string) => string;

  findStagedScratchpadViolations: ExecutionService["findStagedScratchpadViolations"];
  findCommittedScratchpadViolations: ExecutionService["findCommittedScratchpadViolations"];
  isScratchpadPath: ExecutionService["isScratchpadPath"];
  autoStageAndCommit: (run: ExecutionRunRecord, workItem: WorkItemRecord, commitMessage?: string) => void;
  createPullRequest: ExecutionService["createPullRequest"];
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_test",
    run_type: "execution",
    work_item_id: "studio-156",
    work_item_name: "Scratchpad commit guards test",
    status: "completed",
    created_at: "2026-04-09T00:00:00.000Z",
    updated_at: "2026-04-09T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "156-scratchpad-commit-guards",
    base_ref: "main",
    worktree_path: "",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-156",
    name: "Scratchpad commit guards",
    kind: "issue",
    state: "in_progress",
    repo: "fusupo/escapement-studio",
    issue_number: 156,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/156",
    scope_hint: null,
    branch: "156-scratchpad-commit-guards",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeService(params: {
  run?: ExecutionRunRecord;
  workItem?: WorkItemRecord;
  gitResponses?: Record<string, string>;
  changedFiles?: string[];
} = {}): HarnessService {
  const service = Object.create(ExecutionService.prototype) as HarnessService;
  const workItem = params.workItem ?? makeWorkItem();
  const gitResponses = params.gitResponses ?? {};

  service.artifactRoot = "/tmp/studio-artifact-test";
  service.logger = { log: vi.fn(), warn: vi.fn() };
  service.workItemsService = {
    get: (_id: string) => workItem,
    update: vi.fn((_id: string, patch: Partial<WorkItemRecord>) => ({ ...workItem, ...patch })),
  };
  // Phase 4a (#230): these methods moved to RunStore. Harness provides
  // a runStore field with spies so assertions like
  // `expect(service.runStore.appendEvent).toHaveBeenCalled(...)` work.
  service.runStore = {
    appendEvent: vi.fn(),
    updateRun: vi.fn((_runId: string, patch: Partial<ExecutionRunRecord>) => ({
      ...(params.run ?? makeRun()),
      ...patch,
    })),
    getRun: (runId: string) => (params.run && params.run.run_id === runId ? params.run : null),
    writeSummary: vi.fn(),
  };
  // Phase 4b (#231): runGhIn / runGitIn / listChangedFiles live on
  // WorktreeService. The harness provides a worktreeService field with
  // all three stubbed.
  service.worktreeService = {
    runGhIn: vi.fn(() => {
      throw new Error("runGhIn should not be called when guard rejects");
    }),
    runGitIn: vi.fn((_cwd: string, args: string[], options?: { allowFailure?: boolean }) => {
      const key = args.join(" ");
      const response = gitResponses[key];
      if (response != null) {
        return response;
      }
      if (options?.allowFailure) {
        return "";
      }
      return "";
    }),
    listChangedFiles: vi.fn(() => params.changedFiles ?? []),
  };
  service.buildPullRequestTitle = () => "title";
  service.buildPullRequestBody = () => "body";
  return service;
}

describe("ADR 014 step 6: scratchpad commit guards", () => {
  let tmpRoot: string;
  let worktree: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-156-"));
    worktree = join(tmpRoot, "wt");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("isScratchpadPath", () => {
    const service = Object.create(ExecutionService.prototype) as HarnessService;

    it("matches SCRATCHPAD_<slug>.md at worktree root", () => {
      expect(service.isScratchpadPath("SCRATCHPAD_studio_156.md")).toBe(true);
    });

    it("matches SCRATCHPAD_<slug>.md at any path depth", () => {
      expect(service.isScratchpadPath("nested/dir/SCRATCHPAD_anything.md")).toBe(true);
      expect(service.isScratchpadPath("deeply/nested/path/SCRATCHPAD_x.md")).toBe(true);
    });

    it("does not match unrelated files", () => {
      expect(service.isScratchpadPath("README.md")).toBe(false);
      expect(service.isScratchpadPath("src/scratchpad.md")).toBe(false);
      expect(service.isScratchpadPath("SCRATCHPAD.md")).toBe(false);
      expect(service.isScratchpadPath("SCRATCHPAD_foo.txt")).toBe(false);
    });
  });

  describe("findStagedScratchpadViolations", () => {
    it("returns [] when the index is clean", () => {
      const service = makeService({
        gitResponses: {
          "diff --cached --name-only": "",
        },
      });
      expect(service.findStagedScratchpadViolations(worktree)).toEqual([]);
    });

    it("returns [] when only non-scratchpad files are staged", () => {
      const service = makeService({
        gitResponses: {
          "diff --cached --name-only": "src.ts\nREADME.md\n",
        },
      });
      expect(service.findStagedScratchpadViolations(worktree)).toEqual([]);
    });

    it("detects a staged SCRATCHPAD_*.md at the root", () => {
      const service = makeService({
        gitResponses: {
          "diff --cached --name-only": "SCRATCHPAD_studio_156.md\n",
        },
      });
      expect(service.findStagedScratchpadViolations(worktree)).toEqual(["SCRATCHPAD_studio_156.md"]);
    });

    it("detects a staged SCRATCHPAD_*.md at a nested path", () => {
      const service = makeService({
        gitResponses: {
          "diff --cached --name-only": "docs/plans/SCRATCHPAD_x.md\nsrc.ts\n",
        },
      });
      expect(service.findStagedScratchpadViolations(worktree)).toEqual(["docs/plans/SCRATCHPAD_x.md"]);
    });
  });

  describe("findCommittedScratchpadViolations", () => {
    it("returns [] when the branch is clean relative to base", () => {
      const service = makeService({
        gitResponses: {
          "diff --name-only main...HEAD": "",
        },
      });
      expect(service.findCommittedScratchpadViolations(worktree, "main")).toEqual([]);
    });

    it("returns [] when only non-scratchpad files were committed", () => {
      const service = makeService({
        gitResponses: {
          "diff --name-only main...HEAD": "src.ts\nREADME.md\n",
        },
      });
      expect(service.findCommittedScratchpadViolations(worktree, "main")).toEqual([]);
    });

    it("detects a scratchpad committed to the branch", () => {
      const service = makeService({
        gitResponses: {
          "diff --name-only main...HEAD": "SCRATCHPAD_studio_156.md\nsrc.ts\n",
        },
      });
      expect(service.findCommittedScratchpadViolations(worktree, "main")).toEqual(["SCRATCHPAD_studio_156.md"]);
    });
  });

  describe("autoStageAndCommit", () => {
    it("commits normally when no scratchpad is staged", () => {
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({
        run,
        workItem,
        gitResponses: {
          "status --porcelain": " M src.ts\n",
          "diff --cached --name-only": "src.ts\n",
          "add -A": "",
          [`commit -m ${workItem.name} (#${workItem.issue_number})`]: "",
        },
      });

      expect(() => service.autoStageAndCommit(run, workItem)).not.toThrow();
      expect(service.worktreeService.runGitIn).toHaveBeenCalledWith(worktree, ["add", "-A"]);
      expect(service.worktreeService.runGitIn).toHaveBeenCalledWith(
        worktree,
        ["commit", "-m", `${workItem.name} (#${workItem.issue_number})`],
      );
      expect(service.runStore.appendEvent).not.toHaveBeenCalled();
    });

    it("is a no-op when the worktree is clean", () => {
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({
        run,
        workItem,
        gitResponses: {
          "status --porcelain": "",
        },
      });

      expect(() => service.autoStageAndCommit(run, workItem)).not.toThrow();
      expect(service.worktreeService.runGitIn).toHaveBeenCalledTimes(1);
      expect(service.worktreeService.runGitIn).toHaveBeenCalledWith(worktree, ["status", "--porcelain"], { allowFailure: true });
      expect(service.runStore.appendEvent).not.toHaveBeenCalled();
    });

    it("throws and emits an event when a scratchpad is staged (does not create a commit)", () => {
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({
        run,
        workItem,
        gitResponses: {
          "status --porcelain": " M SCRATCHPAD_studio_156.md\n",
          "add -A": "",
          "diff --cached --name-only": "SCRATCHPAD_studio_156.md\n",
        },
      });

      expect(() => service.autoStageAndCommit(run, workItem)).toThrow(BadRequestException);
      expect(() => service.autoStageAndCommit(run, workItem)).toThrow(/auto_commit_blocked_by_scratchpad/);
      expect(service.runStore.appendEvent).toHaveBeenCalledWith(run, {
        type: "scratchpad_commit_blocked",
        phase: "auto_commit",
        paths: ["SCRATCHPAD_studio_156.md"],
      });
      expect(service.worktreeService.runGitIn).not.toHaveBeenCalledWith(
        worktree,
        ["commit", "-m", `${workItem.name} (#${workItem.issue_number})`],
      );
    });
  });

  describe("createPullRequest guards", () => {
    it("rejects with phase=pull_request when the index contains a scratchpad (auto_commit: false)", async () => {
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({
        run,
        workItem,
        gitResponses: {
          "diff --cached --name-only": "SCRATCHPAD_studio_156.md\n",
        },
      });

      await expect(
        service.createPullRequest({
          run_id: run.run_id,
          auto_commit: false,
          base_ref: "main",
        }),
      ).rejects.toThrow(/pull_request_blocked_by_scratchpad/);

      expect(service.runStore.appendEvent).toHaveBeenCalledWith(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request",
        paths: ["SCRATCHPAD_studio_156.md"],
      });
      expect(service.worktreeService.runGhIn).not.toHaveBeenCalled();
      expect(service.worktreeService.runGitIn).not.toHaveBeenCalledWith(
        worktree,
        ["push", "--set-upstream", "origin", run.branch],
      );
    });

    it("rejects with phase=pull_request_history when the branch has a committed scratchpad", async () => {
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({
        run,
        workItem,
        gitResponses: {
          "diff --cached --name-only": "",
          "diff --name-only main...HEAD": "SCRATCHPAD_studio_156.md\nsrc.ts\n",
        },
      });

      await expect(
        service.createPullRequest({
          run_id: run.run_id,
          auto_commit: false,
          base_ref: "main",
        }),
      ).rejects.toThrow(/pull_request_blocked_by_committed_scratchpad/);

      expect(service.runStore.appendEvent).toHaveBeenCalledWith(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request_history",
        paths: ["SCRATCHPAD_studio_156.md"],
      });
      expect(service.worktreeService.runGhIn).not.toHaveBeenCalled();
    });
  });

  describe("no leftover gitignore mutation", () => {
    it("executeRun no longer writes SCRATCHPAD_*.md to the worktree .gitignore", () => {
      const service = Object.create(ExecutionService.prototype) as Record<string, unknown>;
      expect(service.ensureScratchpadIgnored).toBeUndefined();
      expect(existsSync(join(worktree, ".gitignore"))).toBe(false);
    });
  });
});
