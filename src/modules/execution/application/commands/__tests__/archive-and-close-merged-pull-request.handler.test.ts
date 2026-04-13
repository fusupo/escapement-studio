import { describe, expect, it, vi } from "vitest";
import { ArchiveAndCloseMergedPullRequestCommand } from "../archive-and-close-merged-pull-request.command.js";
import { ArchiveAndCloseMergedPullRequestHandler } from "../archive-and-close-merged-pull-request.handler.js";

describe("ArchiveAndCloseMergedPullRequestHandler", () => {
  it("delegates to RunDispositionService.archiveAndCloseMergedPullRequest with the workItemId", async () => {
    const archiveAndCloseMergedPullRequest = vi
      .fn()
      .mockResolvedValue({ work_item: { id: "studio-17", state: "archived" } });
    const disposition = { archiveAndCloseMergedPullRequest } as never;
    const handler = new ArchiveAndCloseMergedPullRequestHandler(disposition);

    const result = await handler.execute(
      new ArchiveAndCloseMergedPullRequestCommand("studio-17"),
    );

    expect(archiveAndCloseMergedPullRequest).toHaveBeenCalledWith("studio-17");
    expect(result).toEqual({ work_item: { id: "studio-17", state: "archived" } });
  });
});
