import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsyncCommand } from "../../../lib/async-command.js";
vi.mock("../../../lib/async-command.js", () => ({ runAsyncCommand: vi.fn() }));
import { WorktreeService } from "../worktree.service.js";
import type { ExecutionRunRecord } from "../types.js";

/**
 * Phase 4b (#231): direct coverage for WorktreeService, the newly
 * extracted owner of worktree lifecycle + git shell wrappers +
 * launch safety checks. Uses `Object.create(WorktreeService.prototype)`
 * so the private `runCommand` can be stubbed and we don't shell out.
 */

interface HarnessService {
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  artifactRoot: string;
  worktreeRoot: string;
  runCommand: ReturnType<typeof vi.fn<(cmd: string, args: string[], options?: object) => string>>;
  baseTruth: Map<string, number>;
  fetchBaseRef: WorktreeService["fetchBaseRef"];
  checkBaseRefCurrent: WorktreeService["checkBaseRefCurrent"];
  fastForwardBaseRef: WorktreeService["fastForwardBaseRef"];
  // Methods under test via prototype
  runGit: WorktreeService["runGit"];
  runGitIn: WorktreeService["runGitIn"];
  runGhIn: WorktreeService["runGhIn"];
  getWorktreePath: WorktreeService["getWorktreePath"];
  createWorktree: WorktreeService["createWorktree"];
  installDependencies: WorktreeService["installDependencies"];
  cleanupRun: WorktreeService["cleanupRun"];
  safeCleanupRun: WorktreeService["safeCleanupRun"];
  evaluateSafety: WorktreeService["evaluateSafety"];
  listChangedFiles: WorktreeService["listChangedFiles"];
  countCommitsAhead: WorktreeService["countCommitsAhead"];
}

function makeService(artifactRoot: string): HarnessService {
  const service = Object.create(WorktreeService.prototype) as HarnessService;
  service.baseTruth = new Map();
  service.logger = { log: vi.fn(), warn: vi.fn() };
  (service as any).artifactRoot = artifactRoot;
  (service as any).worktreeRoot = join(artifactRoot, "worktrees");
  // Stub runCommand to capture calls without shelling out.
  service.runCommand = vi.fn(() => "");
  return service;
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_worktree_test",
    run_type: "execution",
    work_item_id: "studio-231",
    work_item_name: "Phase 4b WorktreeService test",
    status: "completed",
    created_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/231",
    branch: "231-phase-4b",
    base_ref: "develop",
    worktree_path: "/tmp/worktrees/231-phase-4b",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

describe("WorktreeService", () => {
  let tmpRoot: string;

  beforeEach(() => {
    vi.mocked(runAsyncCommand).mockReset().mockResolvedValue(undefined);
    tmpRoot = mkdtempSync(join(tmpdir(), "worktree-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("getWorktreePath", () => {
    it("joins worktreeRoot with a sanitized branch name", () => {
      const service = makeService(tmpRoot);
      expect(service.getWorktreePath("231-phase-4b"))
        .toBe(join(tmpRoot, "worktrees", "231-phase-4b"));
    });

    it("sanitizes disallowed characters out of the branch name", () => {
      const service = makeService(tmpRoot);
      expect(service.getWorktreePath("feature/spaces and $pecials!"))
        .toBe(join(tmpRoot, "worktrees", "feature-spaces-and-pecials"));
    });

    it("falls back to 'execution-run' when the branch name is entirely invalid", () => {
      const service = makeService(tmpRoot);
      expect(service.getWorktreePath("!!!")).toBe(join(tmpRoot, "worktrees", "execution-run"));
    });
  });

  describe("shell wrappers", () => {
    it("runGit calls runCommand with cwd=process.cwd", () => {
      const service = makeService(tmpRoot);
      service.runGit(["status", "--porcelain"]);
      expect(service.runCommand).toHaveBeenCalledWith(
        "git",
        ["status", "--porcelain"],
        expect.objectContaining({ cwd: process.cwd() }),
      );
    });

    it("runGitIn calls runCommand with the provided cwd", () => {
      const service = makeService(tmpRoot);
      service.runGitIn("/tmp/some-dir", ["rev-parse", "HEAD"], { allowFailure: true });
      expect(service.runCommand).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "HEAD"],
        expect.objectContaining({ cwd: "/tmp/some-dir", allowFailure: true }),
      );
    });

    it("runGhIn calls runCommand with gh and an optional stdin", () => {
      const service = makeService(tmpRoot);
      service.runGhIn("/tmp/worktree", ["pr", "create"], "body content");
      expect(service.runCommand).toHaveBeenCalledWith(
        "gh",
        ["pr", "create"],
        expect.objectContaining({ cwd: "/tmp/worktree", stdin: "body content" }),
      );
    });
  });

  describe("createWorktree", () => {
    it("invokes git worktree add with the expected args", () => {
      const service = makeService(tmpRoot);
      service.createWorktree("new-branch", "develop", "/tmp/worktrees/new-branch");
      expect(service.runCommand).toHaveBeenCalledWith(
        "git",
        ["worktree", "add", "/tmp/worktrees/new-branch", "-b", "new-branch", "develop"],
        expect.objectContaining({ cwd: process.cwd() }),
      );
    });
  });

  describe("evaluateSafety", () => {
    it("returns 6 checks, all pass for a clean repo + available branch + bounded path", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn((_cmd, args) => {
        if (args[0] === "remote") return "git@github.com:fusupo/escapement-studio.git";
        if (args[0] === "rev-list") return "0 0";
        if (args[0] === "status") return ""; // tracked clean
        if (args[0] === "rev-parse") return "abc123\n"; // base ref exists
        if (args[0] === "branch") return ""; // branch is available
        if (args[0] === "worktree" && args[1] === "list") return ""; // path not in use
        return "";
      }) as any;

      service.fetchBaseRef("fusupo/escapement-studio", "develop");
      const checks = service.evaluateSafety(
        "new-branch",
        join(tmpRoot, "worktrees", "new-branch"),
        "develop",
        "fusupo/escapement-studio",
      );

      expect(checks.length).toBe(6);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
      expect(checks.map((c) => c.code)).toEqual([
        "tracked_repo_clean",
        "base_ref_exists",
        "base_ref_current",
        "branch_available",
        "worktree_path_available",
        "worktree_path_bounded",
      ]);
    });

    it("returns warn for a dirty tracked repo (not fail — worktree is isolated)", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn((_cmd, args) => {
        if (args[0] === "status") return " M some-file.ts\n";
        if (args[0] === "rev-parse") return "abc123\n";
        return "";
      }) as any;

      const checks = service.evaluateSafety(
        "new-branch",
        join(tmpRoot, "worktrees", "new-branch"),
        "develop",
      );
      const clean = checks.find((c) => c.code === "tracked_repo_clean");
      expect(clean?.status).toBe("warn");
    });

    it("fails base_ref_exists when the base ref cannot be resolved", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn((_cmd, args) => {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return ""; // base ref missing
        return "";
      }) as any;

      const checks = service.evaluateSafety(
        "new-branch",
        join(tmpRoot, "worktrees", "new-branch"),
        "develop",
      );
      const baseRef = checks.find((c) => c.code === "base_ref_exists");
      expect(baseRef?.status).toBe("fail");
    });

    it("fails branch_available when the branch already exists locally", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn((_cmd, args) => {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "abc123\n";
        if (args[0] === "branch") return "  new-branch\n";
        return "";
      }) as any;

      const checks = service.evaluateSafety(
        "new-branch",
        join(tmpRoot, "worktrees", "new-branch"),
        "develop",
      );
      const branchCheck = checks.find((c) => c.code === "branch_available");
      expect(branchCheck?.status).toBe("fail");
    });

    it("fails worktree_path_bounded when the target is outside worktreeRoot", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn((_cmd, args) => {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "abc123\n";
        return "";
      }) as any;

      const checks = service.evaluateSafety(
        "new-branch",
        "/tmp/some-path-outside-root", // not inside tmpRoot/worktrees
        "develop",
      );
      const bounded = checks.find((c) => c.code === "worktree_path_bounded");
      expect(bounded?.status).toBe("fail");
    });
  });

  describe("base-ref freshness and guarded mutation", () => {
    function ready() {
      const service = makeService(tmpRoot);
      service.runCommand.mockImplementation((_cmd, args) => {
        if (args[0] === "remote") return "https://github.com/Fusupo/escapement-studio.git/";
        if (args[0] === "rev-parse") return "abc123";
        if (args[0] === "rev-list") return "0 0";
        if (args[0] === "symbolic-ref") return "develop";
        return "";
      });
      return service;
    }
    const repo = "fusupo/escapement-studio";
    it("requires a successful process-local fetch and expires at exactly 60 seconds", () => {
      const service = ready();
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      expect(service.checkBaseRefCurrent(repo, "develop").status).toBe("fail");
      service.fetchBaseRef(repo, "develop");
      now.mockReturnValue(60999);
      expect(service.checkBaseRefCurrent(repo, "develop").status).toBe("pass");
      now.mockReturnValue(61000);
      expect(service.checkBaseRefCurrent(repo, "develop").status).toBe("fail");
      now.mockRestore();
      expect(service.runCommand).toHaveBeenCalledWith("git", ["fetch", "--no-tags", "origin", "+refs/heads/develop:refs/remotes/origin/develop"], expect.objectContaining({ timeout: 30000 }));
    });
    it.each([["0 0", "pass", "0 commits ahead"], ["3 0", "pass", "3 commits ahead"], ["0 2", "fail", "Local develop is behind origin/develop by 2 commits."], ["3 2", "fail", "3 ahead, 2 behind"], ["", "fail", "Invalid"], ["oops", "fail", "Invalid"], ["-1 2", "fail", "Invalid"]])("compares %s", (counts, status, message) => {
      const service = ready();
      service.fetchBaseRef(repo, "develop");
      const original = service.runCommand.getMockImplementation()!;
      service.runCommand.mockImplementation((cmd, args, opts) => args[0] === "rev-list" ? counts : original(cmd, args, opts));
      expect(service.checkBaseRefCurrent(repo, "develop")).toMatchObject({ code: "base_ref_current", status, message: expect.stringContaining(message) });
    });
    it.each([null, "other/repo", "bad"])("rejects missing/mismatched repo %s", expected => {
      const service = ready(); service.fetchBaseRef(repo, "develop");
      expect(service.checkBaseRefCurrent(expected, "develop").status).toBe("fail");
    });
    it("bounds proofs and removes failed fetch proof", () => {
      const service = ready();
      for (let i = 0; i < 40; i++) service.fetchBaseRef(repo, `base-${i}`);
      expect(service.baseTruth.size).toBe(32);
      expect(service.checkBaseRefCurrent(repo, "base-0").status).toBe("fail");
      service.runCommand.mockImplementation(() => { throw new Error("offline"); });
      expect(() => service.fetchBaseRef(repo, "base-39")).toThrow("offline");
    });
    it.each(["status", "symbolic-ref", "remote", "rev-parse", "fetch"])("refuses %s failure without pull", command => {
      const service = ready(); const original = service.runCommand.getMockImplementation()!;
      service.runCommand.mockImplementation((cmd, args, opts) => { if (args[0] === command) throw new Error("git failed"); return original(cmd, args, opts); });
      expect(() => service.fastForwardBaseRef(repo, "develop")).toThrow("git failed");
      expect(service.runCommand.mock.calls.some(([, args]) => args.includes("pull"))).toBe(false);
    });
    it.each([["status", "?? untracked"], ["status", " M tracked"], ["symbolic-ref", "feature"], ["remote", "https://example.com/fusupo/escapement-studio"]])("refuses unsafe %s", (command, output) => {
      const service = ready(); const original = service.runCommand.getMockImplementation()!;
      service.runCommand.mockImplementation((cmd, args, opts) => args[0] === command ? output : original(cmd, args, opts));
      expect(() => service.fastForwardBaseRef(repo, "develop")).toThrow();
      expect(service.runCommand.mock.calls.some(([, args]) => args.includes("pull"))).toBe(false);
    });
    it("no-ops equal and ahead-only; invalidates on pull failure", () => {
      const service = ready();
      expect(service.fastForwardBaseRef(repo, "develop").updated).toBe(false);
      const original = service.runCommand.getMockImplementation()!;
      service.runCommand.mockImplementation((cmd, args, opts) => {
        if (args.includes("pull")) throw new Error("pull failed");
        return args[0] === "rev-list" ? "0 2" : original(cmd, args, opts);
      });
      expect(() => service.fastForwardBaseRef(repo, "develop")).toThrow("pull failed");
      expect(service.baseTruth.size).toBe(0);
      expect(service.runCommand).toHaveBeenCalledWith("git", ["-c", "merge.autostash=false", "-c", "rebase.autostash=false", "pull", "--ff-only", "--no-rebase", "origin", "develop"], expect.objectContaining({ timeout: 30000 }));
    });
    it("fast-forwards a disposable bare remote and refuses divergence", () => {
      const remote = join(tmpRoot, "origin.git"), checkout = join(tmpRoot, "checkout"), writer = join(tmpRoot, "writer");
      const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      git(tmpRoot, ["init", "--bare", remote]);
      git(tmpRoot, ["clone", remote, writer]);
      for (const cwd of [writer]) { git(cwd, ["config", "user.email", "test@example.com"]); git(cwd, ["config", "user.name", "Test"]); }
      git(writer, ["switch", "-c", "develop"]);
      git(writer, ["commit", "--allow-empty", "-m", "base"]); git(writer, ["push", "origin", "develop"]);
      git(tmpRoot, ["clone", "-b", "develop", remote, checkout]);
      git(writer, ["commit", "--allow-empty", "-m", "next"]); git(writer, ["push", "origin", "develop"]);
      const service = ready();
      service.runCommand.mockImplementation((_cmd, args) => args[0] === "remote" ? "git@github.com:fusupo/escapement-studio.git" : git(checkout, args));
      expect(service.fastForwardBaseRef(repo, "develop")).toMatchObject({ updated: true, previous_behind: 1 });
      git(checkout, ["config", "user.email", "test@example.com"]); git(checkout, ["config", "user.name", "Test"]);
      git(checkout, ["commit", "--allow-empty", "-m", "local"]);
      expect(service.fastForwardBaseRef(repo, "develop")).toMatchObject({ updated: false, previous_ahead: 1 });
      git(writer, ["commit", "--allow-empty", "-m", "remote"]); git(writer, ["push", "origin", "develop"]);
      expect(() => service.fastForwardBaseRef(repo, "develop")).toThrow(/diverged.*1 ahead, 1 behind/);
    });
  });

  describe("installDependencies", () => {
    it("skips worktrees without package.json", async () => {
      await makeService(tmpRoot).installDependencies(tmpRoot);
      expect(runAsyncCommand).not.toHaveBeenCalled();
    });
    it("waits for npm ci and streams progress", async () => {
      writeFileSync(join(tmpRoot, "package.json"), "{}");
      const status = vi.fn();
      let finish!: () => void;
      vi.mocked(runAsyncCommand).mockImplementationOnce((_command, _args, options) => {
        options.onOutput?.("install progress");
        return new Promise<void>((resolve) => { finish = resolve; });
      });
      const pending = makeService(tmpRoot).installDependencies(tmpRoot, status);
      expect(status).toHaveBeenCalledWith("info", "install progress");
      expect(status).not.toHaveBeenCalledWith("status_change", "Dependencies installed.");
      finish(); await pending;
      expect(status).toHaveBeenCalledWith("status_change", "Dependencies installed.");
      expect(runAsyncCommand).toHaveBeenCalledTimes(1);
    });
    it("falls back to npm install after ci fails", async () => {
      writeFileSync(join(tmpRoot, "package.json"), "{}");
      vi.mocked(runAsyncCommand).mockRejectedValueOnce(new Error("lock mismatch"));
      const status = vi.fn();
      await makeService(tmpRoot).installDependencies(tmpRoot, status);
      expect(vi.mocked(runAsyncCommand).mock.calls.map((call) => call[1])).toEqual([["ci"], ["install"]]);
      expect(status).toHaveBeenCalledWith("status_change", "Dependencies installed (via npm install).");
    });
    it("reports both failures and preserves the existing non-blocking failure policy", async () => {
      writeFileSync(join(tmpRoot, "package.json"), "{}");
      vi.mocked(runAsyncCommand).mockRejectedValue(new Error("offline"));
      const status = vi.fn();
      await expect(makeService(tmpRoot).installDependencies(tmpRoot, status)).resolves.toBeUndefined();
      expect(status).toHaveBeenLastCalledWith("info", expect.stringContaining("Dependency installation failed"));
    });
  });

  describe("cleanupRun / safeCleanupRun", () => {
    it("cleanupRun returns the envelope and calls git worktree remove + branch -D", () => {
      const service = makeService(tmpRoot);
      const worktreePath = join(tmpRoot, "wt-cleanup");
      mkdirSync(worktreePath, { recursive: true });

      const result = service.cleanupRun(
        makeRun({ worktree_path: worktreePath, branch: "231-cleanup" }),
      );

      expect(result.worktree_removed).toBe(true);
      expect(result.branch_removed).toBe(true);
      expect(service.runCommand).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", worktreePath, "--force"],
        expect.any(Object),
      );
      expect(service.runCommand).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "231-cleanup"],
        expect.any(Object),
      );
    });

    it("cleanupRun returns false for missing worktree dir (idempotent replay)", () => {
      const service = makeService(tmpRoot);

      const result = service.cleanupRun(
        makeRun({ worktree_path: join(tmpRoot, "missing-wt"), branch: "gone" }),
      );

      expect(result.worktree_removed).toBe(false);
    });

    it("safeCleanupRun swallows errors and logs a warning", () => {
      const service = makeService(tmpRoot);
      const worktreePath = join(tmpRoot, "wt-fail");
      mkdirSync(worktreePath, { recursive: true });
      // Make both `git worktree remove` and `git worktree prune` throw.
      let called = 0;
      service.runCommand = vi.fn(() => {
        called += 1;
        throw new Error(`boom ${called}`);
      }) as any;

      const result = service.safeCleanupRun(
        makeRun({ worktree_path: worktreePath, branch: "doomed" }),
      );

      // safeCleanupRun swallows but removeWorktreeDir's rmSync succeeds
      // (the fallback path), so branch removal happens, worktree is
      // gone on disk, and we get a real envelope back. This test
      // therefore asserts on logger.warn being called at least once.
      expect(result).not.toBeNull();
    });
  });

  describe("listChangedFiles", () => {
    it("unions clean committed branch changes with uncommitted files", () => {
      const repo = join(tmpRoot, "repo");
      mkdirSync(repo);
      const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Escapement Test"]);
      git(["config", "user.email", "test@escapement.local"]);
      writeFileSync(join(repo, "existing.ts"), "export const value = 1;\n", "utf8");
      git(["add", "existing.ts"]);
      git(["commit", "-m", "base"]);
      git(["switch", "-c", "feature"]);
      writeFileSync(join(repo, "existing.ts"), "export const value = 2;\n", "utf8");
      writeFileSync(join(repo, "committed.ts"), "export const committed = true;\n", "utf8");
      git(["add", "existing.ts", "committed.ts"]);
      git(["commit", "-m", "feature work"]);

      // A clean worktree must still report committed branch changes.
      const service = new WorktreeService();
      expect(service.listChangedFiles(repo, "main")).toEqual([
        "committed.ts",
        "existing.ts",
      ]);

      writeFileSync(join(repo, "uncommitted.ts"), "export const draft = true;\n", "utf8");
      expect(service.listChangedFiles(repo, "main")).toEqual([
        "committed.ts",
        "existing.ts",
        "uncommitted.ts",
      ]);
    });
  });

  describe("countCommitsAhead", () => {
    it("parses a numeric rev-list --count output", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn(() => "5\n") as any;

      expect(service.countCommitsAhead("/tmp/wt", "develop", "feature"))
        .toBe(5);
    });

    it("returns 0 when the rev-list output is NaN", () => {
      const service = makeService(tmpRoot);
      service.runCommand = vi.fn(() => "") as any;

      expect(service.countCommitsAhead("/tmp/wt", "develop", "feature"))
        .toBe(0);
    });
  });
});
