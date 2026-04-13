import { describe, expect, it, vi } from "vitest";
import { CancelWorkItemCommand } from "../cancel-work-item.command.js";
import { CancelWorkItemHandler } from "../cancel-work-item.handler.js";

describe("CancelWorkItemHandler", () => {
  it("delegates to RunDispositionService.cancelWorkItem with the dto", async () => {
    const cancelWorkItem = vi.fn().mockResolvedValue({ cancelled: true });
    const disposition = { cancelWorkItem } as never;
    const handler = new CancelWorkItemHandler(disposition);

    const result = await handler.execute(
      new CancelWorkItemCommand({
        work_item_id: "studio-42",
        confirm_cancel: true,
        cancel_note: "test",
      }),
    );

    expect(cancelWorkItem).toHaveBeenCalledWith({
      work_item_id: "studio-42",
      confirm_cancel: true,
      cancel_note: "test",
    });
    expect(result).toEqual({ cancelled: true });
  });
});
