import { describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import { selectPullRequest } from "../../../../web/src/lib/pull-request.js";

describe("planning pull request projection", () => {
  it("prefers confirmed merged metadata over stale PR-open metadata", () => {
    const merged = {
      number: 275,
      state: "closed",
      merged_at: "2026-07-20T22:00:00.000Z",
    };
    const item = {
      pull_request: { number: 275, state: "open", merged_at: null },
      meta: {
        pull_request: { number: 275, state: "OPEN", merged_at: null },
        studio_post_merge_sync: { pull_request: merged },
      },
    };

    expect(selectPullRequest(item)).toBe(merged);
  });

  it("falls back to available open metadata before merge", () => {
    const open = { number: 275, state: "open", merged_at: null };
    expect(selectPullRequest({ pull_request: open })).toBe(open);
  });
});
