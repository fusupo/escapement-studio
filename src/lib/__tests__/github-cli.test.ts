import { describe, expect, it, vi } from "vitest";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("../gh-runner.js", () => ({ runGh }));

import { fetchIssueBody } from "../github-cli.js";

describe("fetchIssueBody", () => {
  it("returns the trimmed issue body with a 15s deadline", async () => {
    runGh.mockResolvedValueOnce("Issue body\n");
    await expect(fetchIssueBody("fusupo/escapement-studio", 290)).resolves.toBe("Issue body");
    expect(runGh).toHaveBeenLastCalledWith(
      ["issue", "view", "290", "--repo", "fusupo/escapement-studio", "--json", "body", "--jq", ".body"],
      { timeoutMs: 15_000 },
    );
  });

  it("returns null for missing inputs without calling gh", async () => {
    runGh.mockClear();
    await expect(fetchIssueBody(null, 290)).resolves.toBeNull();
    await expect(fetchIssueBody("fusupo/escapement-studio", null)).resolves.toBeNull();
    expect(runGh).not.toHaveBeenCalled();
  });

  it("returns null when gh fails, times out, or the body is empty", async () => {
    runGh.mockRejectedValueOnce(new Error("gh command timed out after 15000ms"));
    await expect(fetchIssueBody("fusupo/escapement-studio", 290)).resolves.toBeNull();
    runGh.mockResolvedValueOnce("\n");
    await expect(fetchIssueBody("fusupo/escapement-studio", 290)).resolves.toBeNull();
  });
});
