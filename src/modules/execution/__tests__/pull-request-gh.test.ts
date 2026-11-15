import { describe, expect, it, vi } from "vitest";
import { PullRequestService } from "../pull-request.service.js";

/** #290: PR read-back awaits the asynchronous gh wrapper. */
describe("PullRequestService gh read-back", () => {
  function makeService(runGhIn: ReturnType<typeof vi.fn>) {
    const service = Object.create(PullRequestService.prototype) as any;
    service.worktreeService = { runGhIn };
    return service;
  }

  it("awaits gh pr view and maps the created pull request", async () => {
    const runGhIn = vi.fn(async () => JSON.stringify({ number: 12, url: "https://example.com/pull/12", title: " Title ", baseRefName: "develop", headRefName: "studio-1-branch", isDraft: true }));
    const record = await makeService(runGhIn).readPullRequest("/tmp/worktree", "Fallback", "Body");
    expect(runGhIn).toHaveBeenCalledWith("/tmp/worktree", ["pr", "view", "--json", "number,url,title,body,baseRefName,headRefName,isDraft"]);
    expect(record).toMatchObject({ number: 12, title: "Title", body: "Body", base_ref: "develop", head_ref: "studio-1-branch", is_draft: true });
  });

  it("rejects when gh fails or times out", async () => {
    const runGhIn = vi.fn(async () => { throw new Error("gh command timed out after 30000ms"); });
    await expect(makeService(runGhIn).readPullRequest("/tmp/worktree", "Fallback", "Body")).rejects.toThrow("timed out");
  });
});
