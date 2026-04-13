import { describe, expect, it, vi } from "vitest";
import { TransitionInProgressToReadyCommand } from "../transition-in-progress-to-ready.command.js";
import { TransitionInProgressToReadyHandler } from "../transition-in-progress-to-ready.handler.js";

describe("TransitionInProgressToReadyHandler", () => {
  it("delegates to ExecutionService.transitionInProgressToReady with the workItemId", async () => {
    const transitionInProgressToReady = vi
      .fn()
      .mockResolvedValue({ id: "studio-7", state: "pre_pr.ready" });
    const execution = { transitionInProgressToReady } as never;
    const handler = new TransitionInProgressToReadyHandler(execution);

    const result = await handler.execute(
      new TransitionInProgressToReadyCommand("studio-7"),
    );

    expect(transitionInProgressToReady).toHaveBeenCalledWith("studio-7");
    expect(result).toEqual({ id: "studio-7", state: "pre_pr.ready" });
  });
});
