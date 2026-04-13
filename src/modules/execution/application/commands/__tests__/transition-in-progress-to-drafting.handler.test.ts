import { describe, expect, it, vi } from "vitest";
import { TransitionInProgressToDraftingCommand } from "../transition-in-progress-to-drafting.command.js";
import { TransitionInProgressToDraftingHandler } from "../transition-in-progress-to-drafting.handler.js";

describe("TransitionInProgressToDraftingHandler", () => {
  it("delegates to ExecutionService.transitionInProgressToDrafting with the workItemId", async () => {
    const transitionInProgressToDrafting = vi
      .fn()
      .mockResolvedValue({ id: "studio-7", state: "pre_pr.drafting" });
    const execution = { transitionInProgressToDrafting } as never;
    const handler = new TransitionInProgressToDraftingHandler(execution);

    const result = await handler.execute(
      new TransitionInProgressToDraftingCommand("studio-7"),
    );

    expect(transitionInProgressToDrafting).toHaveBeenCalledWith("studio-7");
    expect(result).toEqual({ id: "studio-7", state: "pre_pr.drafting" });
  });
});
