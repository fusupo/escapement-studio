import { beforeEach, describe, expect, it, vi } from "vitest";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/gh-runner.js", () => ({ runGh }));

import { GitHubItemLookup } from "../github-item-lookup.service.js";

const rawPull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  url: "https://github.com/fusupo/escapement-studio/pull/7",
  title: "PR",
  state: "OPEN",
  isDraft: false,
  baseRefName: "develop",
  headRefName: "studio-100-branch",
  mergedAt: null,
  ...overrides,
});

describe("GitHubItemLookup", () => {
  const lookup = new GitHubItemLookup();
  beforeEach(() => runGh.mockReset());

  it("asks gh for one branch's pull requests, in any state", async () => {
    runGh.mockResolvedValueOnce(JSON.stringify([rawPull()]));
    const pulls = await lookup.pullRequestsForBranch(" fusupo/escapement-studio ", " studio-100-branch ");
    expect(runGh).toHaveBeenCalledWith([
      "pr", "list", "--repo", "fusupo/escapement-studio", "--head", "studio-100-branch", "--state", "all",
      "--json", "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt",
    ]);
    expect(pulls).toEqual([{
      number: 7, state: "OPEN", merged_at: null, head_ref: "studio-100-branch", base_ref: "develop",
      url: "https://github.com/fusupo/escapement-studio/pull/7", title: "PR", is_draft: false,
    }]);
  });

  it("keeps only exact branch matches and reads MERGED from mergedAt", async () => {
    runGh.mockResolvedValueOnce(JSON.stringify([
      rawPull({ number: 8, headRefName: "studio-100-branch-2" }),
      rawPull({ number: 9, state: "CLOSED", mergedAt: "2026-11-14T00:00:00Z" }),
      rawPull({ number: 10, state: "closed" }),
    ]));
    const pulls = await lookup.pullRequestsForBranch("fusupo/escapement-studio", "studio-100-branch");
    expect(pulls.map((pull) => [pull.number, pull.state])).toEqual([[9, "MERGED"], [10, "CLOSED"]]);
  });

  it("returns an empty list when the branch has no pull request", async () => {
    runGh.mockResolvedValueOnce("[]");
    await expect(lookup.pullRequestsForBranch("fusupo/escapement-studio", "nothing")).resolves.toEqual([]);
  });

  it("reads one issue's state", async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({
      number: 100, title: "Issue", url: "https://github.com/fusupo/escapement-studio/issues/100",
      state: "CLOSED", closedAt: "2026-11-14T01:00:00Z",
    }));
    const issue = await lookup.issue("fusupo/escapement-studio", 100);
    expect(runGh).toHaveBeenCalledWith([
      "issue", "view", "100", "--repo", "fusupo/escapement-studio", "--json", "number,title,url,state,closedAt",
    ]);
    expect(issue).toEqual({
      number: 100, state: "closed", closed_at: "2026-11-14T01:00:00Z",
      url: "https://github.com/fusupo/escapement-studio/issues/100", title: "Issue",
    });
  });

  it("rejects when gh fails", async () => {
    runGh.mockRejectedValueOnce(new Error("gh command timed out after 30000ms"));
    await expect(lookup.issue("fusupo/escapement-studio", 100)).rejects.toThrow(/timed out/);
  });

  it("reads one issue with its body", async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({
      number: 281, title: "Import", url: "https://github.com/fusupo/escapement-studio/issues/281",
      state: "OPEN", closedAt: null, body: "Depends on #12",
    }));
    const issue = await lookup.issueWithBody("fusupo/escapement-studio", 281);
    expect(runGh).toHaveBeenCalledWith([
      "issue", "view", "281", "--repo", "fusupo/escapement-studio", "--json", "number,title,url,state,closedAt,body",
    ]);
    expect(issue).toEqual({
      number: 281, state: "open", closed_at: null, title: "Import",
      url: "https://github.com/fusupo/escapement-studio/issues/281", body: "Depends on #12",
    });
  });

  it("treats a missing body as empty", async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({ number: 1, title: "T", url: "u", state: "OPEN", body: null }));
    expect((await lookup.issueWithBody("fusupo/escapement-studio", 1)).body).toBe("");
  });
});
