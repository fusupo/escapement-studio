import { describe, expect, it, vi } from "vitest";
import { CloseMergedPullRequestCommand } from "../close-merged-pull-request.command.js";
import { CloseMergedPullRequestHandler } from "../close-merged-pull-request.handler.js";

describe("CloseMergedPullRequestHandler", () => {
  it("delegates to RunDispositionService.closeMergedPullRequest with the workItemId", async () => {
    const closeMergedPullRequest = vi
      .fn()
      .mockResolvedValue({ work_item: { id: "studio-17", state: "done" } });
    const disposition = { closeMergedPullRequest } as never;
    const handler = new CloseMergedPullRequestHandler(disposition);

    const result = await handler.execute(
      new CloseMergedPullRequestCommand("studio-17"),
    );

    expect(closeMergedPullRequest).toHaveBeenCalledWith("studio-17");
    expect(result).toEqual({ work_item: { id: "studio-17", state: "done" } });
  });
});
