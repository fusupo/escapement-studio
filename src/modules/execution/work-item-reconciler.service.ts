import { Inject, Injectable, Logger } from "@nestjs/common";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../../config.js";
import { runsRoot, worktreesRoot } from "../../lib/context-layout.js";
import { GitHubService } from "../github/github.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord } from "../graph/types.js";
import {
  detectAndMarkOrphans,
  loadRunRecordsFromDisk,
  type OrphanDetectionResult,
} from "./run-disk-store.js";
import type { ExecutionRunRecord } from "./types.js";
import type {
  NextAction,
  ReconcileSummary,
  ReconciledPullRequest,
  ReconciledWorkItem,
  ReconciledWorktree,
} from "./work-item-reconciler.types.js";

/**
 * Injectable git runner so unit tests can stub worktree probes without
 * hitting the real filesystem. Production code uses `defaultGitRunner`.
 */
export interface GitRunner {
  run(args: string[], options: { cwd: string }): string;
}

export const defaultGitRunner: GitRunner = {
  run(args, { cwd }) {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 4 });
    } catch {
      return "";
    }
  },
};

/** Minimal disk-store contract — matches the exported helpers from
 * `run-disk-store.ts`. Parameterized so tests can stub loading. */
export interface ReconcilerDiskStore {
  loadRunRecords(runsDir: string): ExecutionRunRecord[];
  detectAndMarkOrphans(runsDir: string, now?: () => string): OrphanDetectionResult[];
}

export const defaultReconcilerDiskStore: ReconcilerDiskStore = {
  loadRunRecords(runsDir) {
    return loadRunRecordsFromDisk(runsDir);
  },
  detectAndMarkOrphans(runsDir, now) {
    return detectAndMarkOrphans(runsDir, now ? { now } : {});
  },
};

export interface ReconcilerOptions {
  /** Filter by a single work item id. When omitted, all `in_progress`
   * work items are reconciled. */
  work_item_id?: string;
}

const EMPTY_NEXT_ACTION_COUNTS: Record<NextAction, number> = {
  open_pr: 0,
  awaiting_review: 0,
  close_out: 0,
  relaunch: 0,
  investigate: 0,
  abandon: 0,
  none: 0,
};

/**
 * Issue #176: joins graph state, runs/<id>/status.json, GitHub PR truth,
 * and worktree state into a derived "next action" view per work item.
 *
 * Pure derived state — no new persistent schema. All IO collaborators
 * (WorkItemsService, GitHubService, disk-store, git runner) are injected
 * so the decision table can be exercised in unit tests with stubs.
 */
@Injectable()
export class WorkItemReconcilerService {
  private readonly logger = new Logger(WorkItemReconcilerService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  private readonly runsDir = runsRoot(this.artifactRoot);
  private readonly worktreeRoot = worktreesRoot(this.artifactRoot);

  /** Overridable for tests — production code uses defaults. */
  diskStore: ReconcilerDiskStore = defaultReconcilerDiskStore;
  gitRunner: GitRunner = defaultGitRunner;
  /** Wrapped so tests can stub filesystem probes without reaching into node:fs. */
  pathExists: (path: string) => boolean = (path) => existsSync(path);

  constructor(
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
  ) {}

  /**
   * Run the orphan-detection pass on disk, rewriting any
   * non-terminal runs to `error` with an explanatory activity_log entry.
   * Returns one entry per rewritten run.
   *
   * Called from ExecutionService.onModuleInit before `reconcile()` so
   * that runs left hanging across a restart enter the decision table as
   * terminal (`error`) records.
   */
  detectOrphans(): OrphanDetectionResult[] {
    return this.diskStore.detectAndMarkOrphans(this.runsDir);
  }

  /**
   * Join graph + disk + GitHub + worktree and produce a
   * `ReconciledWorkItem` per `in_progress` work item (or just the one
   * matching `options.work_item_id`).
   *
   * The decision table row order is preserved: earlier rows win when
   * multiple conditions match (e.g. close_out beats awaiting_review when
   * both a completed run and a merged PR exist).
   */
  async reconcile(options: ReconcilerOptions = {}): Promise<ReconciledWorkItem[]> {
    const workItems = this.selectWorkItems(options);
    if (workItems.length === 0) {
      return [];
    }

    const runs = this.diskStore.loadRunRecords(this.runsDir);
    const runsByWorkItem = new Map<string, ExecutionRunRecord[]>();
    for (const run of runs) {
      const list = runsByWorkItem.get(run.work_item_id) ?? [];
      list.push(run);
      runsByWorkItem.set(run.work_item_id, list);
    }

    const out: ReconciledWorkItem[] = [];
    for (const workItem of workItems) {
      const latestRun = this.pickLatestRun(runsByWorkItem.get(workItem.id) ?? []);
      const worktree = this.probeWorktree(workItem, latestRun);
      const githubPr = await this.probePullRequest(workItem, latestRun);
      // Issue #85: only probe issue state when the PR is merged —
      // non-close_out rows never consume `github_issue_state`, and
      // `gh issue view` is rate-limited, so skip the call otherwise.
      const githubIssueState = this.shouldProbeIssueState(githubPr)
        ? await this.probeIssueState(workItem)
        : null;
      const { nextAction, rationale } = decideNextAction({ workItem, latestRun, worktree, githubPr });

      out.push({
        work_item_id: workItem.id,
        graph_state: workItem.state,
        latest_run: latestRun,
        github_pr: githubPr,
        worktree,
        github_issue_state: githubIssueState,
        next_action: nextAction,
        rationale,
      });
    }

    return out;
  }

  /**
   * Issue #85: only fetch GitHub issue state when the reconciled PR is
   * merged. The Execution tab's Close / Archive-and-close gate only
   * consumes `github_issue_state` for close_out rows, so skipping the
   * `gh issue view` call on every in-progress reconcile keeps the
   * common case cheap.
   */
  private shouldProbeIssueState(githubPr: ReconciledPullRequest | null): boolean {
    if (!githubPr) return false;
    return githubPr.state === "MERGED" || Boolean(githubPr.merged_at);
  }

  /**
   * Issue #85: probe the linked GitHub issue and return its normalized
   * state ("open" | "closed"). Mirrors `probePullRequest`'s graceful
   * degradation — a failing `gh issue view` logs a warning and returns
   * `null` so the UI can render a safe default (no disposition action).
   */
  private async probeIssueState(workItem: WorkItemRecord): Promise<"open" | "closed" | null> {
    if (!workItem.repo || typeof workItem.issue_number !== "number" || !Number.isInteger(workItem.issue_number)) {
      return null;
    }
    try {
      const issue = await this.githubService.readIssue(workItem.repo, workItem.issue_number);
      const raw = (issue?.state ?? "").toString().toLowerCase();
      if (raw === "open" || raw === "closed") return raw;
      return null;
    } catch (error) {
      this.logger.warn(
        `readIssue failed for ${workItem.repo}#${workItem.issue_number}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Convenience wrapper used by the startup path: runs orphan detection,
   * then reconciles, then emits a summary line. Returns both the
   * reconciled list and a structured summary so callers can assert on the
   * numbers.
   */
  async runStartupReconcile(): Promise<{
    reconciled: ReconciledWorkItem[];
    orphans: OrphanDetectionResult[];
    summary: ReconcileSummary;
  }> {
    const orphans = this.detectOrphans();
    const reconciled = await this.reconcile();
    const summary = this.buildSummary(reconciled, orphans);

    this.logger.log(
      `Startup reconcile: ${summary.total} work item(s), ${summary.orphans_rewritten} orphan(s) rewritten, ` +
        Object.entries(summary.next_actions)
          .filter(([, count]) => count > 0)
          .map(([action, count]) => `${action}=${count}`)
          .join(" ") || "Startup reconcile: no work items to reconcile",
    );

    return { reconciled, orphans, summary };
  }

  private selectWorkItems(options: ReconcilerOptions): WorkItemRecord[] {
    if (options.work_item_id) {
      try {
        const single = this.workItemsService.get(options.work_item_id);
        return single.state === "in_progress" ? [single] : [];
      } catch {
        return [];
      }
    }
    return this.workItemsService.list({ state: "in_progress" });
  }

  private pickLatestRun(runs: ExecutionRunRecord[]): ExecutionRunRecord | null {
    if (runs.length === 0) return null;
    // runs are already sorted by updated_at desc from loadRunRecordsFromDisk,
    // but we defensively sort again in case a caller passes raw input.
    return [...runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!;
  }

  private probeWorktree(workItem: WorkItemRecord, latestRun: ExecutionRunRecord | null): ReconciledWorktree | null {
    const branch = latestRun?.branch ?? workItem.branch ?? null;
    if (!branch) return null;

    // Prefer the run's recorded worktree_path (absolute path), falling
    // back to the canonical worktrees root for this artifactRoot. This
    // lets reconciles still find the worktree even when the branch name
    // has been sanitized.
    const worktreePath = latestRun?.worktree_path?.trim() || this.worktreePathForBranch(branch);

    if (!this.pathExists(worktreePath)) {
      return { exists: false, branch, commits_ahead: 0, dirty: false };
    }

    const baseRef = latestRun?.base_ref?.trim() || this.defaultBaseRefForWorkItem(workItem);
    const aheadRaw = this.gitRunner
      .run(["rev-list", "--count", `${baseRef}..${branch}`], { cwd: worktreePath })
      .trim();
    const aheadParsed = Number(aheadRaw);
    const commitsAhead = Number.isFinite(aheadParsed) ? aheadParsed : 0;

    const statusRaw = this.gitRunner.run(["status", "--porcelain"], { cwd: worktreePath });
    const dirty = statusRaw.trim().length > 0;

    return { exists: true, branch, commits_ahead: commitsAhead, dirty };
  }

  private async probePullRequest(
    workItem: WorkItemRecord,
    latestRun: ExecutionRunRecord | null,
  ): Promise<ReconciledPullRequest | null> {
    // Prefer the PR already stored on the latest run — avoids a network
    // call and matches what the run UI already shows.
    const storedPr = latestRun?.pull_request;
    if (storedPr && Number.isInteger(storedPr.number)) {
      return {
        number: storedPr.number,
        state: storedPr.state ?? "OPEN",
        merged_at: storedPr.merged_at ?? null,
        url: storedPr.url,
      };
    }

    const repo = workItem.repo ?? latestRun?.repo ?? null;
    const branch = latestRun?.branch ?? workItem.branch ?? null;
    if (!repo || !branch) return null;

    try {
      const found = await this.githubService.findPullRequestForBranch(repo, branch);
      if (!found) return null;
      return {
        number: found.number,
        state: found.state,
        merged_at: found.merged_at,
        url: found.url,
      };
    } catch (error) {
      this.logger.warn(
        `findPullRequestForBranch failed for ${repo}#${branch}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private worktreePathForBranch(branch: string): string {
    const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "execution-run";
    return `${this.worktreeRoot}/${safeBranch}`;
  }

  private defaultBaseRefForWorkItem(_workItem: WorkItemRecord): string {
    // The reconciler's `commits_ahead` is an informational hint — a
    // wrong base_ref degrades to 0 (via the NaN guard) rather than a
    // crash. The decision table only uses `commits_ahead > 0` as a
    // tie-breaker for open_pr vs none, so "develop" is a safe default
    // until we wire per-repo base refs through the reconciler.
    return "develop";
  }

  private buildSummary(reconciled: ReconciledWorkItem[], orphans: OrphanDetectionResult[]): ReconcileSummary {
    const counts: Record<NextAction, number> = { ...EMPTY_NEXT_ACTION_COUNTS };
    for (const item of reconciled) {
      counts[item.next_action] += 1;
    }
    return {
      total: reconciled.length,
      orphans_rewritten: orphans.length,
      next_actions: counts,
      generated_at: new Date().toISOString(),
    };
  }
}

/* ── Pure decision table — exported for unit testing ───────────────────── */

export interface DecisionInputs {
  workItem: WorkItemRecord;
  latestRun: ExecutionRunRecord | null;
  worktree: ReconciledWorktree | null;
  githubPr: ReconciledPullRequest | null;
}

export interface DecisionResult {
  nextAction: NextAction;
  rationale: string;
}

/**
 * Apply the #176 decision table in the exact order specified in the
 * issue. Each branch produces a rationale string explaining which
 * inputs drove the verdict, so operators can trace "why did the
 * reconciler say this?" without re-running the pipeline.
 *
 * Row order (earliest match wins):
 *   1. completed run + merged PR           → close_out
 *   2. completed run + open PR             → awaiting_review
 *   3. completed run + closed (not merged) → abandon
 *   4. completed run + no PR + commits ahead → open_pr
 *   5. completed run + no PR + no commits  → none
 *   6. error run                           → investigate
 *   7. non-terminal / missing run          → relaunch
 */
export function decideNextAction(inputs: DecisionInputs): DecisionResult {
  const { latestRun, worktree, githubPr } = inputs;

  if (!latestRun) {
    const detail = worktree?.exists
      ? `worktree exists on branch ${worktree.branch}; no run recorded on disk`
      : "no run recorded on disk and no worktree present";
    return {
      nextAction: "relaunch",
      rationale: `Work item is in_progress but ${detail}. Relaunch to create a fresh run.`,
    };
  }

  if (latestRun.status === "completed") {
    if (githubPr?.state === "MERGED" || githubPr?.merged_at) {
      return {
        nextAction: "close_out",
        rationale: `Completed run ${latestRun.run_id} and PR #${githubPr.number} is merged. Hand off to close-out actions.`,
      };
    }
    if (githubPr?.state === "OPEN") {
      return {
        nextAction: "awaiting_review",
        rationale: `Completed run ${latestRun.run_id} and PR #${githubPr.number} is open. Waiting on review.`,
      };
    }
    if (githubPr?.state === "CLOSED") {
      return {
        nextAction: "abandon",
        rationale: `Completed run ${latestRun.run_id} but PR #${githubPr.number} was closed without merge. Investigate or abandon.`,
      };
    }
    // No PR on GitHub yet.
    const commitsAhead = worktree?.commits_ahead ?? 0;
    if (commitsAhead > 0) {
      return {
        nextAction: "open_pr",
        rationale: `Completed run ${latestRun.run_id}, no PR yet, ${commitsAhead} commit(s) ahead of base on branch ${latestRun.branch}. Ready to open PR.`,
      };
    }
    return {
      nextAction: "none",
      rationale: `Completed run ${latestRun.run_id}, no PR, and no commits ahead of base. Nothing to do.`,
    };
  }

  if (latestRun.status === "error" || latestRun.status === "blocked") {
    return {
      nextAction: "investigate",
      rationale: `Latest run ${latestRun.run_id} ended in status "${latestRun.status}". ${latestRun.progress_message ?? "Investigate before relaunching."}`,
    };
  }

  // Any remaining non-terminal status slips through orphan detection
  // (e.g. a run produced by the currently-active server). Offer relaunch
  // as the safest default — the user can inspect the live run first.
  return {
    nextAction: "relaunch",
    rationale: `Latest run ${latestRun.run_id} is in status "${latestRun.status}" (non-terminal). If it is not actively running, relaunch.`,
  };
}
