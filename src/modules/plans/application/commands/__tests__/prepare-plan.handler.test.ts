import { describe, expect, it, vi } from "vitest";
import { PreparePlanCommand } from "../prepare-plan.command.js";
import { PreparePlanHandler } from "../prepare-plan.handler.js";

describe("PreparePlanHandler", () => {
  it("delegates to PlansService.prepare with the workItemId", async () => {
    const prepare = vi
      .fn()
      .mockResolvedValue({ work_item_id: "studio-3", metadata: { state: "drafting" } });
    const plans = { prepare } as never;
    const handler = new PreparePlanHandler(plans);

    const result = await handler.execute(new PreparePlanCommand("studio-3"));

    expect(prepare).toHaveBeenCalledWith("studio-3");
    expect(result).toEqual({ work_item_id: "studio-3", metadata: { state: "drafting" } });
  });
});
