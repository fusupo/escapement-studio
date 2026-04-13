import { describe, expect, it, vi } from "vitest";
import { ReopenPlanCommand } from "../reopen-plan.command.js";
import { ReopenPlanHandler } from "../reopen-plan.handler.js";

describe("ReopenPlanHandler", () => {
  it("delegates to PlansService.reopen with the workItemId", async () => {
    const reopen = vi
      .fn()
      .mockResolvedValue({ work_item_id: "studio-3", metadata: { state: "drafting" } });
    const plans = { reopen } as never;
    const handler = new ReopenPlanHandler(plans);

    const result = await handler.execute(new ReopenPlanCommand("studio-3"));

    expect(reopen).toHaveBeenCalledWith("studio-3");
    expect(result).toEqual({ work_item_id: "studio-3", metadata: { state: "drafting" } });
  });
});
