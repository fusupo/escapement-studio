import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionService } from "../../execution/execution.service.js";
import type { PlansService } from "../../plans/plans.service.js";
import type { DispatchResult, WorkItemRecord, WorkItemState } from "../types.js";
import type { WorkItemHsmService } from "../work-item-hsm.service.js";
import { WorkItemsController } from "../work-items.controller.js";
import type { WorkItemsService } from "../work-items.service.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-153",
    name: "Test item",
    kind: "issue",
    state: "planned",
    repo: "fusupo/escapement-studio",
    issue_number: 153,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/153",
    scope_hint: null,
    branch: "studio-153-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeDispatchResult(
  current: WorkItemRecord,
  event: { type: string },
  nextState: WorkItemState,
): DispatchResult {
  return {
    work_item_id: current.id,
    prev_state: current.state,
    next_state: nextState,
    event: event as DispatchResult["event"],
    applied_actions: [],
    mutation_applied: true,
    rejected: false,
  };
}

function makeController(options: {
  initialState?: WorkItemState;
  enabledEvents?: string[];
} = {}) {
  let current = makeWorkItem({ state: options.initialState ?? "planned" });

  const workItemsService = {
    get: vi.fn((id: string) => {
      if (id !== current.id) throw new Error(`Unknown: ${id}`);
      return current;
    }),
    update: vi.fn((id: string, patch: Partial<WorkItemRecord>) => {
      current = { ...current, ...patch };
      return current;
    }),
  } as unknown as WorkItemsService;

  const hsmService = {
    getEnabledEvents: vi.fn(() => options.enabledEvents ?? []),
    dispatch: vi.fn(async (_id: string, event: { type: string }) => {
      const nextStateMap: Partial<Record<string, WorkItemState>> = {
        "user.defer": "deferred",
        "user.undefer": "planned",
        "user.investigate": "pre_pr.ready",
      };
      const nextState = nextStateMap[event.type] ?? current.state;
      const result = makeDispatchResult(current, event, nextState);
      current = { ...current, state: nextState };
      return result;
    }),
  } as unknown as WorkItemHsmService;

  const executionService = {
    transitionInProgressToReady: vi.fn(async (_id: string) => {
      current = { ...current, state: "pre_pr.ready" };
      return current;
    }),
    transitionInProgressToDrafting: vi.fn(async (_id: string) => {
      current = { ...current, state: "pre_pr.drafting" };
      return current;
    }),
    cancelWorkItem: vi.fn(async (_id: string) => {
      current = { ...current, state: "cancelled" };
      return current;
    }),
  } as unknown as ExecutionService;

  const plansService = {
    prepare: vi.fn(async (_id: string) => {
      current = { ...current, state: "pre_pr.drafting" };
      return {
        work_item_id: current.id,
        metadata: { state: "drafting" },
        scratchpad_content: "# scratchpad",
      };
    }),
    reopen: vi.fn(async (_id: string) => {
      current = { ...current, state: "pre_pr.drafting" };
      return {
        work_item_id: current.id,
        metadata: { state: "drafting" },
        scratchpad_content: "# scratchpad",
      };
    }),
  } as unknown as PlansService;

  const controller = new WorkItemsController(workItemsService, hsmService, executionService, plansService);

  return {
    controller,
    workItemsService,
    hsmService,
    executionService,
    plansService,
    getCurrent: () => current,
  };
}

describe("WorkItemsController.transition", () => {
  it("routes planned -> user.start_draft through PlansService.prepare", async () => {
    const harness = makeController({
      initialState: "planned",
      enabledEvents: ["user.start_draft"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.start_draft" });

    expect(harness.plansService.prepare).toHaveBeenCalledWith("studio-153");
    expect(harness.plansService.reopen).not.toHaveBeenCalled();
    expect(harness.executionService.transitionInProgressToDrafting).not.toHaveBeenCalled();
    expect(result.state).toBe("pre_pr.drafting");
  });

  it("routes ready -> user.start_draft through PlansService.reopen", async () => {
    const harness = makeController({
      initialState: "ready",
      enabledEvents: ["user.start_draft"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.start_draft" });

    expect(harness.plansService.reopen).toHaveBeenCalledWith("studio-153");
    expect(harness.plansService.prepare).not.toHaveBeenCalled();
    expect(result.state).toBe("pre_pr.drafting");
  });

  it("routes in_progress -> user.start_draft through ExecutionService.transitionInProgressToDrafting", async () => {
    const harness = makeController({
      initialState: "in_progress",
      enabledEvents: ["user.start_draft"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.start_draft" });

    expect(harness.executionService.transitionInProgressToDrafting).toHaveBeenCalledWith("studio-153");
    expect(harness.plansService.prepare).not.toHaveBeenCalled();
    expect(result.state).toBe("pre_pr.drafting");
  });

  it("routes in_progress -> user.investigate through ExecutionService.transitionInProgressToReady", async () => {
    const harness = makeController({
      initialState: "in_progress",
      enabledEvents: ["user.investigate"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.investigate" });

    expect(harness.executionService.transitionInProgressToReady).toHaveBeenCalledWith("studio-153");
    expect(harness.hsmService.dispatch).not.toHaveBeenCalled();
    expect(result.state).toBe("pre_pr.ready");
  });

  it("routes run_errored -> user.investigate through the HSM", async () => {
    const harness = makeController({
      initialState: "pre_pr.run_errored",
      enabledEvents: ["user.investigate"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.investigate" });

    expect(harness.hsmService.dispatch).toHaveBeenCalledWith("studio-153", { type: "user.investigate" });
    expect(harness.executionService.transitionInProgressToReady).not.toHaveBeenCalled();
    expect(result.state).toBe("pre_pr.ready");
  });

  it("dispatches user.defer directly through the HSM", async () => {
    const harness = makeController({
      initialState: "ready",
      enabledEvents: ["user.defer"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.defer" });

    expect(harness.hsmService.dispatch).toHaveBeenCalledWith("studio-153", { type: "user.defer" });
    expect(result.state).toBe("deferred");
  });

  it("dispatches user.undefer directly through the HSM", async () => {
    const harness = makeController({
      initialState: "deferred",
      enabledEvents: ["user.undefer"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.undefer" });

    expect(harness.hsmService.dispatch).toHaveBeenCalledWith("studio-153", { type: "user.undefer" });
    expect(result.state).toBe("planned");
  });

  it("routes user.cancel through ExecutionService.cancelWorkItem", async () => {
    const harness = makeController({
      initialState: "ready",
      enabledEvents: ["user.cancel"],
    });

    const result = await harness.controller.transition("studio-153", { event: "user.cancel" });

    expect(harness.executionService.cancelWorkItem).toHaveBeenCalledWith("studio-153");
    expect(harness.hsmService.dispatch).not.toHaveBeenCalled();
    expect(result.state).toBe("cancelled");
  });

  it("rejects unsupported transition events", async () => {
    const harness = makeController({
      initialState: "merged_pr",
      enabledEvents: ["user.finalize"],
    });

    await expect(
      harness.controller.transition("studio-153", { event: "user.finalize" as never }),
    ).rejects.toThrow(/Unsupported work-item transition event/);
  });

  it("rejects events that are not enabled by the HSM from the current state", async () => {
    const harness = makeController({
      initialState: "open_pr",
      enabledEvents: [],
    });

    await expect(
      harness.controller.transition("studio-153", { event: "user.cancel" }),
    ).rejects.toThrow(/is not enabled from state open_pr/);
  });

  it("rejects a missing `event` field", async () => {
    const harness = makeController();
    await expect(
      harness.controller.transition("studio-153", {} as { event: "user.defer" }),
    ).rejects.toThrow(/event.*required/);
  });
});

describe("WorkItemsController.update", () => {
  it("rejects direct state patches", () => {
    const harness = makeController();

    expect(() => harness.controller.update("studio-153", {
      name: "Renamed",
      state: "done",
    })).toThrow(BadRequestException);
  });

  it("still allows non-state work item edits", () => {
    const harness = makeController();

    const result = harness.controller.update("studio-153", {
      name: "Renamed",
      scope_hint: "new scope",
    });

    expect(harness.workItemsService.update).toHaveBeenCalledWith("studio-153", {
      name: "Renamed",
      scope_hint: "new scope",
    });
    expect(result.name).toBe("Renamed");
    expect(result.scope_hint).toBe("new scope");
  });
});
