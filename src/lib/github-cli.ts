import { runGh } from "./gh-runner.js";

/**
 * Thin wrappers around the `gh` CLI. Extracted in ADR 014 step 4 (#154) so
 * that both `ExecutionService` and `PlansService` can reach for the same
 * issue-fetching helper without duplicating the `gh` invocation or creating
 * an inter-module dependency for a simple utility.
 *
 * All helpers here are asynchronous (#290) and swallow `gh` failures by
 * returning `null` — the caller decides how to surface missing issue data.
 */

/**
 * Fetch the body of a GitHub issue via `gh issue view`. Resolves with the
 * body text, or `null` if inputs are missing, the CLI fails or times out,
 * or the body is empty.
 *
 * Uses a 15s timeout to avoid holding the calling request on flaky network
 * conditions.
 */
export async function fetchIssueBody(repo: string | null, issueNumber: number | null): Promise<string | null> {
  if (!repo || !issueNumber) return null;
  try {
    const raw = await runGh(
      ["issue", "view", String(issueNumber), "--repo", repo, "--json", "body", "--jq", ".body"],
      { timeoutMs: 15_000 },
    );
    return raw.trim() || null;
  } catch {
    return null;
  }
}
