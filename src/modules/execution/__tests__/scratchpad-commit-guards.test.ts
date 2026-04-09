import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

/**
 * ADR 014 step 6: scratchpad commit guards.
 *
 * These tests run against real `git init` worktrees in tmp directories so
 * that the `git diff --cached --name-only` and `git diff --name-only $base...HEAD`
 * calls exercise actual git index / history semantics. Mocking git would
 * defeat the purpose of the guards.
 *
 * Harness pattern matches launch-eligibility.test.ts: Object.create the
 * ExecutionService prototype and wire up only the collaborators the code
 * under test touches.
 */

interface HarnessService {
  artifactRoot: string;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  workItemsService: { get: (id: string) => WorkItemRecord; update: ReturnType<typeof vi.fn> };
  appendEvent: ReturnType<typeof vi.fn>;
  updateRun: ReturnType<typeof vi.fn>;
  getRun: (runId: string) => ExecutionRunRecord | undefined;
  runGhIn: ReturnType<typeof vi.fn>;
  writeSummary: ReturnType<typeof vi.fn>;
  buildPullRequestTitle: (workItem: WorkItemRecord) => string;
  buildPullRequestBody: (run: ExecutionRunRecord, workItem: WorkItemRecord, baseRef: string) => string;

  // Methods under test (prototype — available via Object.create)
  findStagedScratchpadViolations: ExecutionService["findStagedScratchpadViolations"];
  findCommittedScratchpadViolations: ExecutionService["findCommittedScratchpadViolations"];
  isScratchpadPath: ExecutionService["isScratchpadPath"];
  autoStageAndCommit: (run: ExecutionRunRecord, workItem: WorkItemRecord, commitMessage?: string) => void;
  createPullRequest: ExecutionService["createPullRequest"];
}

function initGitRepo(worktreePath: string, baseBranch = "main"): void {
  mkdirSync(worktreePath, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", baseBranch], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: worktreePath });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: worktreePath });
  // Seed an initial commit so `$base...HEAD` has a valid merge-base
  writeFileSync(join(worktreePath, "README.md"), "# base\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: worktreePath });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: worktreePath });
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

function makeService(params: { run?: ExecutionRunRecord; workItem?: WorkItemRecord } = {}): HarnessService {
  const service = Object.create(ExecutionService.prototype) as HarnessService;
  const workItem = params.workItem ?? makeWorkItem();
  service.artifactRoot = "/tmp/studio-artifact-test";
  service.logger = { log: vi.fn(), warn: vi.fn() };
  service.workItemsService = {
    get: (_id: string) => workItem,
    update: vi.fn((_id: string, patch: Partial<WorkItemRecord>) => ({ ...workItem, ...patch })),
  };
  service.appendEvent = vi.fn();
  service.updateRun = vi.fn((_runId: string, patch: Partial<ExecutionRunRecord>) => ({
    ...(params.run ?? makeRun()),
    ...patch,
  }));
  service.getRun = (runId: string) => (params.run && params.run.run_id === runId ? params.run : undefined);
  // Fail the test if the code under test attempts a gh call or push —
  // the guards must throw BEFORE any side effect.
  service.runGhIn = vi.fn(() => {
    throw new Error("runGhIn should not be called when guard rejects");
  });
  service.writeSummary = vi.fn();
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
    initGitRepo(worktree);
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
      expect(service.isScratchpadPath("src/scratchpad.md")).toBe(false); // lowercase
      expect(service.isScratchpadPath("SCRATCHPAD.md")).toBe(false); // no underscore+slug
      expect(service.isScratchpadPath("SCRATCHPAD_foo.txt")).toBe(false); // wrong extension
    });
  });

  describe("findStagedScratchpadViolations", () => {
    it("returns [] when the index is clean", () => {
      const service = makeService();
      expect(service.findStagedScratchpadViolations(worktree)).toEqual([]);
    });

    it("returns [] when only non-scratchpad files are staged", () => {
      writeFileSync(join(worktree, "src.ts"), "export {};\n", "utf8");
      execFileSync("git", ["add", "src.ts"], { cwd: worktree });
      const service = makeService();
      expect(service.findStagedScratchpadViolations(worktree)).toEqual([]);
    });

    it("detects a staged SCRATCHPAD_*.md at the root", () => {
      writeFileSync(join(worktree, "SCRATCHPAD_studio_156.md"), "secret plan\n", "utf8");
      execFileSync("git", ["add", "SCRATCHPAD_studio_156.md"], { cwd: worktree });
      const service = makeService();
      expect(service.findStagedScratchpadViolations(worktree)).toEqual(["SCRATCHPAD_studio_156.md"]);
    });

    it("detects a staged SCRATCHPAD_*.md at a nested path", () => {
      mkdirSync(join(worktree, "docs", "plans"), { recursive: true });
      writeFileSync(join(worktree, "docs", "plans", "SCRATCHPAD_x.md"), "nested\n", "utf8");
      execFileSync("git", ["add", "docs/plans/SCRATCHPAD_x.md"], { cwd: worktree });
      const service = makeService();
      expect(service.findStagedScratchpadViolations(worktree)).toEqual(["docs/plans/SCRATCHPAD_x.md"]);
    });
  });

  describe("findCommittedScratchpadViolations", () => {
    it("returns [] when the branch is clean relative to base", () => {
      const service = makeService();
      expect(service.findCommittedScratchpadViolations(worktree, "main")).toEqual([]);
    });

    it("returns [] when only non-scratchpad files were committed", () => {
      execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: worktree });
      writeFileSync(join(worktree, "src.ts"), "export {};\n", "utf8");
      execFileSync("git", ["add", "src.ts"], { cwd: worktree });
      execFileSync("git", ["commit", "-q", "-m", "feat"], { cwd: worktree });
      const service = makeService();
      expect(service.findCommittedScratchpadViolations(worktree, "main")).toEqual([]);
    });

    it("detects a scratchpad committed to the branch", () => {
      execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: worktree });
      writeFileSync(join(worktree, "SCRATCHPAD_studio_156.md"), "leaked\n", "utf8");
      execFileSync("git", ["add", "SCRATCHPAD_studio_156.md"], { cwd: worktree });
      execFileSync("git", ["commit", "-q", "-m", "oops"], { cwd: worktree });
      const service = makeService();
      expect(service.findCommittedScratchpadViolations(worktree, "main")).toEqual(["SCRATCHPAD_studio_156.md"]);
    });
  });

  describe("autoStageAndCommit", () => {
    it("commits normally when no scratchpad is staged", () => {
      writeFileSync(join(worktree, "src.ts"), "export {};\n", "utf8");
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({ run, workItem });

      expect(() => service.autoStageAndCommit(run, workItem)).not.toThrow();

      // A new commit should exist
      const log = execFileSync("git", ["log", "--oneline"], { cwd: worktree, encoding: "utf8" });
      expect(log.split("\n").filter((l) => l.trim()).length).toBe(2); // initial + feat
      // No block event should have been emitted
      expect(service.appendEvent).not.toHaveBeenCalled();
    });

    it("is a no-op when the worktree is clean", () => {
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({ run, workItem });

      expect(() => service.autoStageAndCommit(run, workItem)).not.toThrow();
      expect(service.appendEvent).not.toHaveBeenCalled();

      // Still only the initial commit
      const log = execFileSync("git", ["log", "--oneline"], { cwd: worktree, encoding: "utf8" });
      expect(log.split("\n").filter((l) => l.trim()).length).toBe(1);
    });

    it("throws and emits an event when a scratchpad is staged (does not create a commit)", () => {
      writeFileSync(join(worktree, "SCRATCHPAD_studio_156.md"), "plan content\n", "utf8");
      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({ run, workItem });

      expect(() => service.autoStageAndCommit(run, workItem)).toThrow(BadRequestException);
      expect(() => service.autoStageAndCommit(run, workItem)).toThrow(/auto_commit_blocked_by_scratchpad/);

      // Called twice because of the two expect().toThrow calls above;
      // assert the payload on one of them.
      expect(service.appendEvent).toHaveBeenCalledWith(run, {
        type: "scratchpad_commit_blocked",
        phase: "auto_commit",
        paths: ["SCRATCHPAD_studio_156.md"],
      });

      // Critically: NO new commit was created
      const log = execFileSync("git", ["log", "--oneline"], { cwd: worktree, encoding: "utf8" });
      expect(log.split("\n").filter((l) => l.trim()).length).toBe(1);
    });
  });

  describe("createPullRequest guards", () => {
    it("rejects with phase=pull_request when the index contains a scratchpad (auto_commit: false)", async () => {
      // Seed: branch off main, staged scratchpad, NO commit yet
      execFileSync("git", ["checkout", "-q", "-b", "156-scratchpad-commit-guards"], { cwd: worktree });
      writeFileSync(join(worktree, "SCRATCHPAD_studio_156.md"), "plan\n", "utf8");
      execFileSync("git", ["add", "SCRATCHPAD_studio_156.md"], { cwd: worktree });

      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({ run, workItem });

      await expect(
        service.createPullRequest({
          run_id: run.run_id,
          auto_commit: false,
          base_ref: "main",
        }),
      ).rejects.toThrow(/pull_request_blocked_by_scratchpad/);

      expect(service.appendEvent).toHaveBeenCalledWith(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request",
        paths: ["SCRATCHPAD_studio_156.md"],
      });
      // No push, no gh call
      expect(service.runGhIn).not.toHaveBeenCalled();
      // No remote created
      const remotes = execFileSync("git", ["remote"], { cwd: worktree, encoding: "utf8" }).trim();
      expect(remotes).toBe("");
    });

    it("rejects with phase=pull_request_history when the branch has a committed scratchpad", async () => {
      // Seed: branch off main, commit a scratchpad, worktree clean after commit
      execFileSync("git", ["checkout", "-q", "-b", "156-scratchpad-commit-guards"], { cwd: worktree });
      writeFileSync(join(worktree, "SCRATCHPAD_studio_156.md"), "leaked\n", "utf8");
      execFileSync("git", ["add", "SCRATCHPAD_studio_156.md"], { cwd: worktree });
      execFileSync("git", ["commit", "-q", "-m", "oops"], { cwd: worktree });

      // Also add an innocuous committed file so the branch has "real" work
      writeFileSync(join(worktree, "src.ts"), "export {};\n", "utf8");
      execFileSync("git", ["add", "src.ts"], { cwd: worktree });
      execFileSync("git", ["commit", "-q", "-m", "feat"], { cwd: worktree });

      const run = makeRun({ worktree_path: worktree });
      const workItem = makeWorkItem();
      const service = makeService({ run, workItem });

      await expect(
        service.createPullRequest({
          run_id: run.run_id,
          auto_commit: false,
          base_ref: "main",
        }),
      ).rejects.toThrow(/pull_request_blocked_by_committed_scratchpad/);

      expect(service.appendEvent).toHaveBeenCalledWith(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request_history",
        paths: ["SCRATCHPAD_studio_156.md"],
      });
      expect(service.runGhIn).not.toHaveBeenCalled();
    });
  });

  describe("no leftover gitignore mutation", () => {
    it("executeRun no longer writes SCRATCHPAD_*.md to the worktree .gitignore", () => {
      // Just a sanity check that the method is gone — the absence is
      // enforced by the type system and the tsc build, but this test
      // documents the ADR 014 step 6 contract directly.
      const service = Object.create(ExecutionService.prototype) as Record<string, unknown>;
      expect(service.ensureScratchpadIgnored).toBeUndefined();
      expect(existsSync(join(worktree, ".gitignore"))).toBe(false);
    });
  });
});
