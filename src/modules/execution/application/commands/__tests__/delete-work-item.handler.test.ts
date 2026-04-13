import { describe, expect, it, vi } from "vitest";
import { DeleteWorkItemCommand } from "../delete-work-item.command.js";
import { DeleteWorkItemHandler } from "../delete-work-item.handler.js";

describe("DeleteWorkItemHandler", () => {
  it("delegates to ExecutionService.deleteWorkItem with the dto", async () => {
    const deleteWorkItem = vi.fn().mockResolvedValue({ deleted: true });
    const execution = { deleteWorkItem } as never;
    const handler = new DeleteWorkItemHandler(execution);

    const result = await handler.execute(
      new DeleteWorkItemCommand({
        work_item_id: "studio-99",
        confirm_delete: true,
        allow_graph_delete_without_github: true,
      }),
    );

    expect(deleteWorkItem).toHaveBeenCalledWith({
      work_item_id: "studio-99",
      confirm_delete: true,
      allow_graph_delete_without_github: true,
    });
    expect(result).toEqual({ deleted: true });
  });
});
