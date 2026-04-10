import { describe, expect, it, vi } from "vitest";
import { WorkItemReconcilerController } from "../work-item-reconciler.controller.js";
import type { WorkItemReconcilerService } from "../work-item-reconciler.service.js";
import type { ReconciledWorkItem } from "../work-item-reconciler.types.js";

function makeReconciled(id: string): ReconciledWorkItem {
  return {
    work_item_id: id,
    graph_state: "in_progress",
    latest_run: null,
    github_pr: null,
    worktree: null,
    next_action: "relaunch",
    rationale: "stub",
  };
}

describe("WorkItemReconcilerController", () => {
  it("returns the reconciled list from the service", async () => {
    const reconcile = vi.fn(async () => [makeReconciled("studio-1"), makeReconciled("studio-2")]);
    const service = { reconcile } as unknown as WorkItemReconcilerService;
    const controller = new WorkItemReconcilerController(service);

    const result = await controller.getReconciled();
    expect(result).toHaveLength(2);
    expect(reconcile).toHaveBeenCalledWith({});
  });

  it("forwards work_item_id filter (trimmed) to the service", async () => {
    const reconcile = vi.fn(async () => [makeReconciled("studio-176")]);
    const service = { reconcile } as unknown as WorkItemReconcilerService;
    const controller = new WorkItemReconcilerController(service);

    const result = await controller.getReconciled("  studio-176  ");
    expect(result).toHaveLength(1);
    expect(reconcile).toHaveBeenCalledWith({ work_item_id: "studio-176" });
  });

  it("omits the filter when work_item_id is blank", async () => {
    const reconcile = vi.fn(async () => []);
    const service = { reconcile } as unknown as WorkItemReconcilerService;
    const controller = new WorkItemReconcilerController(service);

    await controller.getReconciled("   ");
    expect(reconcile).toHaveBeenCalledWith({});
  });
});
