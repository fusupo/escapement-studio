import type { ExecutionRunRecord } from "./types.js";
import type { WorkItemState } from "../graph/types.js";

/**
 * Issue #176: pure derived view that joins graph state, run artifacts on
 * disk, GitHub PR truth, and worktree state into a single "next action"
 * verdict per work item. No new persistent schema — the reconciler loads
 * each source on demand and the output is recomputed on every call.
 *
 * See docs/dev/cc-archive/.../SCRATCHPAD_studio_176.md for the decision
 * table and orphan-detection rationale.
 */
export type NextAction =
  | "open_pr" // completed run + commits ahead + no PR
  | "awaiting_review" // completed run + open PR
  | "close_out" // completed run + merged PR (hands off to #83-89)
  | "relaunch" // orphaned mid-run or no run recorded
  | "investigate" // failed run
  | "abandon" // dead PR (closed without merge)
  | "none"; // no action needed

/** GitHub PR snapshot kept deliberately narrow — the reconciler only needs
 * the fields that drive the decision table. Full PR details still come from
 * `GitHubService.findPullRequestForBranch` / `readPullRequest`. */
export interface ReconciledPullRequest {
  number: number;
  state: string; // "OPEN" | "CLOSED" | "MERGED" per gh
  merged_at: string | null;
  url: string;
}

/** Worktree probe result. `exists: false` means the directory is absent
 * (e.g. cleaned up post-merge); in that case the other fields are
 * reported as their empty defaults. */
export interface ReconciledWorktree {
  exists: boolean;
  branch: string;
  commits_ahead: number;
  dirty: boolean;
}

/**
 * Derived view of a single work item's post-run state. Pure function of
 * the four input sources — recomputed on every `reconcile()` call.
 *
 * - `graph_state` mirrors `WorkItemRecord.state` at read time
 * - `latest_run` is loaded from `runs/<id>/status.json` (disk), not from
 *   `ExecutionService.recentRuns`; `null` when no matching run exists
 * - `github_pr` is `null` when the work item has no branch, when the
 *   underlying `gh` call fails, or when no PR exists for the branch
 * - `worktree` is `null` only when no branch is known; otherwise it is a
 *   probe result (may have `exists: false`)
 * - `rationale` is a short human-readable string summarizing which inputs
 *   drove the `next_action` verdict; used by the UI and startup log
 */
export interface ReconciledWorkItem {
  work_item_id: string;
  graph_state: WorkItemState;
  latest_run: ExecutionRunRecord | null;
  github_pr: ReconciledPullRequest | null;
  worktree: ReconciledWorktree | null;
  next_action: NextAction;
  rationale: string;
}

/** Summary emitted by the startup reconcile pass. Used both by the Nest
 * `Logger` output and, optionally, by tests that assert the log line. */
export interface ReconcileSummary {
  total: number;
  orphans_rewritten: number;
  next_actions: Record<NextAction, number>;
  generated_at: string;
}
