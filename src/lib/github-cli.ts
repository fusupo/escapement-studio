import { execFileSync } from "node:child_process";

/**
 * Thin wrappers around the `gh` CLI. Extracted in ADR 014 step 4 (#154) so
 * that both `ExecutionService` and `PlansService` can reach for the same
 * issue-fetching helper without duplicating the `gh` invocation or creating
 * an inter-module dependency for a simple utility.
 *
 * All helpers here are synchronous and swallow `gh` failures by returning
 * `null` — the caller decides how to surface missing issue data.
 */

/**
 * Fetch the body of a GitHub issue via `gh issue view`. Returns the body
 * text, or `null` if inputs are missing, the CLI fails, or the body is empty.
 *
 * Uses a 15s timeout to avoid hanging the calling request on flaky network
 * conditions.
 */
export function fetchIssueBody(repo: string | null, issueNumber: number | null): string | null {
  if (!repo || !issueNumber) return null;
  try {
    const raw = execFileSync(
      "gh",
      ["issue", "view", String(issueNumber), "--repo", repo, "--json", "body", "--jq", ".body"],
      { encoding: "utf8", timeout: 15000 },
    ).trim();
    return raw || null;
  } catch {
    return null;
  }
}
