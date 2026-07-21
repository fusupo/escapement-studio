import { Injectable, Logger } from "@nestjs/common";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { worktreesRoot } from "../../lib/context-layout.js";
import { getDefaultWorkingBranch } from "./default-working-branches.js";
import { parseChangedFilePath } from "./execution.service.js";
import type {
  CleanupWorktreeResult,
  ExecutionRunRecord,
  ExecutionSafetyCheck,
} from "./types.js";

/**
 * Phase 4b of the cqrs refactor (#231): owns every
 * `execFileSync('git'|'gh', ...)` call in the execution module plus
 * worktree lifecycle management (create / remove / list / safety
 * checks). Extracted verbatim from ExecutionService.
 *
 * Shell wrappers (`runGit`, `runGitIn`, `runGhIn`, `runCommand`) are
 * public because ExecutionService's remaining pull-request-creation
 * and scratchpad-commit-guard code still needs to shell out until
 * Phase 4c (ScratchpadService) and Phase 4e (PullRequestService)
 * extract those clusters. Single owner of `execFileSync('git'|'gh')`.
 *
 * Takes no injected dependencies — all state is either a constant or
 * computed from `getConfig()`. Tests construct directly via
 * `Object.create(WorktreeService.prototype)` or `new WorktreeService()`.
 *
 * Two new public methods compared to the originals:
 *
 *   - `createWorktree(branch, baseRef, worktreePath)` — wraps the
 *     inline `git worktree add` call from ExecutionService.executeRun
 *   - `installDependencies(worktreePath, onStatus?)` — wraps the
 *     inline `npm ci` → `npm install --ignore-scripts` fallback block
 *     from ExecutionService.executeRun. Takes an optional callback so
 *     the orchestrator can still push activity-log entries.
 */
@Injectable()
export class WorktreeService {
  private readonly logger = new Logger(WorktreeService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  private readonly worktreeRoot = worktreesRoot(this.artifactRoot);

  // ─── Shell wrappers (public) ──────────────────────────────────────

  runGit(args: string[], options: { allowFailure?: boolean } = {}): string {
    return this.runCommand("git", args, { cwd: process.cwd(), allowFailure: options.allowFailure });
  }

  runGitIn(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): string {
    return this.runCommand("git", args, { cwd, allowFailure: options.allowFailure });
  }

  runGhIn(cwd: string, args: string[], stdin?: string): string {
    return this.runCommand("gh", args, { cwd, stdin });
  }

  runCommand(
    command: string,
    args: string[],
    options: { cwd: string; stdin?: string; allowFailure?: boolean },
  ): string {
    try {
      return execFileSync(command, args, {
        cwd: options.cwd,
        input: options.stdin,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      if (options.allowFailure) {
        return "";
      }
      throw error;
    }
  }

  // ─── Worktree lifecycle ───────────────────────────────────────────

  getWorktreePath(branch: string): string {
    const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "execution-run";
    return join(this.worktreeRoot, safeBranch);
  }

  /**
   * Phase 4b (#231): wraps the inline `git worktree add` call that
   * ExecutionService.executeRun used to make directly. Creates a new
   * worktree at `worktreePath` with `branch` checked out from
   * `baseRef`.
   */
  createWorktree(branch: string, baseRef: string, worktreePath: string): void {
    this.runGit(["worktree", "add", worktreePath, "-b", branch, baseRef]);
  }

  /**
   * Phase 4b (#231): wraps the inline `npm ci` → `npm install`
   * fallback block that ExecutionService.executeRun used to run
   * inline after creating a worktree. Skips silently when the
   * worktree has no package.json. Swallows both install failures
   * with a warning — the original behaviour was that a failed
   * install didn't block the run, the agent just couldn't run
   * quality checks.
   *
   * The optional `onStatus` callback lets the orchestrator continue
   * to push activity-log entries for the in-progress `pushActivity`
   * helper. If omitted, failures are logged via the service logger
   * only.
   */
  installDependencies(
    worktreePath: string,
    onStatus?: (kind: "info" | "status_change", message: string) => void,
  ): void {
    if (!existsSync(join(worktreePath, "package.json"))) {
      return;
    }
    onStatus?.("status_change", "Installing dependencies in worktree...");
    try {
      // The worktree is created from the locally trusted base ref before the
      // coding agent can modify it. Allow dependency lifecycle scripts here:
      // native dependencies such as better-sqlite3 otherwise install without
      // their bindings and make the run's quality checks fail spuriously.
      execFileSync("npm", ["ci"], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 120000,
        stdio: "pipe",
      });
      onStatus?.("status_change", "Dependencies installed.");
      return;
    } catch (npmErr) {
      const message = npmErr instanceof Error ? npmErr.message : String(npmErr);
      onStatus?.("info", `npm ci failed, trying npm install: ${message.slice(0, 200)}`);
      try {
        execFileSync("npm", ["install"], {
          cwd: worktreePath,
          encoding: "utf8",
          timeout: 120000,
          stdio: "pipe",
        });
        onStatus?.("status_change", "Dependencies installed (via npm install).");
        return;
      } catch {
        onStatus?.("info", "Dependency installation failed — agent may not be able to run quality checks.");
      }
    }
  }

  /**
   * Orchestrator helper: invoked by ExecutionService.cleanupWorktree
   * after the run is looked up via RunStore and the status-active
   * guard passes. Returns the CleanupWorktreeResult envelope.
   */
  cleanupRun(run: ExecutionRunRecord): CleanupWorktreeResult {
    return this.removeWorktreeAndBranch(run);
  }

  /**
   * Orchestrator helper: invoked by ExecutionService.cleanupAllStale
   * for each stale run. Returns `null` on failure (logged and
   * swallowed) so the orchestrator can continue iterating.
   */
  safeCleanupRun(run: ExecutionRunRecord): CleanupWorktreeResult | null {
    try {
      return this.removeWorktreeAndBranch(run);
    } catch (error) {
      this.logger.warn(`Failed to cleanup worktree for run ${run.run_id}: ${error}`);
      return null;
    }
  }

  private removeWorktreeAndBranch(run: ExecutionRunRecord): CleanupWorktreeResult {
    const worktreeRemoved = this.removeWorktreeDir(run.worktree_path);
    const branchRemoved = this.removeLocalBranch(run.branch);

    if (worktreeRemoved || branchRemoved) {
      this.logger.log(`Cleaned up run ${run.run_id}: worktree=${worktreeRemoved}, branch=${branchRemoved}`);
    }

    return {
      run_id: run.run_id,
      branch: run.branch,
      worktree_path: run.worktree_path,
      worktree_removed: worktreeRemoved,
      branch_removed: branchRemoved,
    };
  }

  private removeWorktreeDir(worktreePath: string): boolean {
    if (!existsSync(worktreePath)) {
      return false;
    }
    try {
      this.runGit(["worktree", "remove", worktreePath, "--force"]);
      return true;
    } catch {
      // Fallback: remove directory and prune
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        this.runGit(["worktree", "prune"]);
        return true;
      } catch (error) {
        this.logger.warn(`Failed to remove worktree at ${worktreePath}: ${error}`);
        return false;
      }
    }
  }

  private removeLocalBranch(branch: string): boolean {
    try {
      this.runGit(["branch", "-D", branch]);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Safety checks ────────────────────────────────────────────────

  evaluateSafety(
    branch: string,
    worktreePath: string,
    baseRef = getDefaultWorkingBranch(null),
  ): ExecutionSafetyCheck[] {
    const checks: ExecutionSafetyCheck[] = [];
    checks.push(this.checkTrackedRepoClean());
    checks.push(this.checkBaseRef(baseRef));
    checks.push(this.checkBranchAvailable(branch));
    checks.push(this.checkWorktreePathAvailable(worktreePath));
    checks.push(this.checkPathBounded(worktreePath));
    return checks;
  }

  private checkTrackedRepoClean(): ExecutionSafetyCheck {
    const output = this.runGit(["status", "--porcelain", "--untracked-files=no"], { allowFailure: true });
    return output.trim().length === 0
      ? { code: "tracked_repo_clean", status: "pass", message: "Repo has no tracked changes that would interfere with dispatch." }
      : { code: "tracked_repo_clean", status: "warn", message: "Repo has tracked local changes, but execution still uses an isolated worktree and will not mutate the main checkout." };
  }

  private checkBaseRef(baseRef: string): ExecutionSafetyCheck {
    const ok = this.runGit(["rev-parse", "--verify", baseRef], { allowFailure: true }).trim().length > 0;
    return ok
      ? { code: "base_ref_exists", status: "pass", message: `Base ref ${baseRef} is available.` }
      : { code: "base_ref_exists", status: "fail", message: `Base ref ${baseRef} was not found.` };
  }

  private checkBranchAvailable(branch: string): ExecutionSafetyCheck {
    const existing = this.runGit(["branch", "--list", branch], { allowFailure: true }).trim();
    return existing.length === 0
      ? { code: "branch_available", status: "pass", message: `Branch ${branch} is available for a new worktree.` }
      : { code: "branch_available", status: "fail", message: `Branch ${branch} already exists locally.` };
  }

  private checkWorktreePathAvailable(worktreePath: string): ExecutionSafetyCheck {
    const listed = this.runGit(["worktree", "list", "--porcelain"], { allowFailure: true });
    return listed.includes(`worktree ${worktreePath}`)
      ? { code: "worktree_path_available", status: "fail", message: `Worktree path ${worktreePath} is already in use.` }
      : { code: "worktree_path_available", status: "pass", message: "Target worktree path is available." };
  }

  private checkPathBounded(worktreePath: string): ExecutionSafetyCheck {
    const boundedRoot = resolve(this.worktreeRoot);
    const target = resolve(worktreePath);
    return target.startsWith(`${boundedRoot}/`) || target === boundedRoot
      ? { code: "worktree_path_bounded", status: "pass", message: "Target worktree path is inside the configured execution worktree root." }
      : { code: "worktree_path_bounded", status: "fail", message: "Target worktree path escaped the configured execution worktree root." };
  }

  // ─── Worktree queries ─────────────────────────────────────────────

  /**
   * Return the complete file set changed by an execution branch.
   *
   * Agents may commit their work before Studio completes the run. `git status`
   * alone therefore produces a false empty result for a clean worktree even
   * though the branch is ahead of its base. Include the merge-base-relative
   * committed diff whenever a base ref is available, then union any staged,
   * unstaged, or untracked paths still present in the worktree.
   */
  listChangedFiles(worktreePath: string, baseRef?: string): string[] {
    const statusOutput = this.runGitIn(worktreePath, ["status", "--short"]);
    const workingTreeFiles = statusOutput
      .split("\n")
      .map((line) => parseChangedFilePath(line))
      .filter((path): path is string => Boolean(path));

    const normalizedBaseRef = baseRef?.trim();
    if (!normalizedBaseRef) {
      return [...new Set(workingTreeFiles)].sort();
    }

    const committedOutput = this.runGitIn(worktreePath, [
      "diff",
      "--name-only",
      "--find-renames",
      `${normalizedBaseRef}...HEAD`,
    ]);
    const committedFiles = committedOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((path) => path.length > 0);

    return [...new Set([...committedFiles, ...workingTreeFiles])].sort();
  }

  countCommitsAhead(worktreePath: string, baseRef: string, branch: string): number {
    const output = this.runGitIn(worktreePath, ["rev-list", "--count", `${baseRef}..${branch}`], { allowFailure: true }).trim();
    const parsed = Number(output);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
