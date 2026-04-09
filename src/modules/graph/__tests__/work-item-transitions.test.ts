import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionService } from "../../execution/execution.service.js";
import { isValidHumanTransition, VALID_HUMAN_TRANSITIONS } from "../state-transitions.js";
import type { WorkItemRecord, WorkItemState } from "../types.js";
import { WorkItemsController } from "../work-items.controller.js";
import type { WorkItemsService } from "../work-items.service.js";

/**
 * Tests for the ADR 014 step 3 human-reviewer transition endpoint.
 *
 * Construct the controller directly with hand-stubbed services rather
 * than booting a full Nest context — the transition logic is pure
 * dispatch and doesn't exercise any framework wiring beyond the
 * decorators.
 */

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

function makeController(initialState: WorkItemState = "planned") {
  let current = makeWorkItem({ state: initialState });

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

  const executionService = {
    transitionInProgressToReady: vi.fn((id: string) => {
      if (current.state !== "in_progress") {
        throw new BadRequestException(`Cannot transition ${id} from ${current.state} to ready`);
      }
      current = { ...current, state: "ready" };
      return current;
    }),
    cancelWorkItem: vi.fn((_id: string) => {
      current = { ...current, state: "cancelled" };
      return current;
    }),
  } as unknown as ExecutionService;

  const controller = new WorkItemsController(workItemsService, executionService);

  return {
    controller,
    workItemsService,
    executionService,
    getCurrent: () => current,
  };
}

describe("WorkItemsController.transition", () => {
  describe("allowed human-reviewer transitions", () => {
    const allowed: Array<[WorkItemState, WorkItemState]> = [
      ["planned", "drafting"],
      ["planned", "deferred"],
      ["planned", "cancelled"],
      ["drafting", "ready"],
      ["drafting", "deferred"],
      ["drafting", "cancelled"],
      ["ready", "drafting"],
      ["ready", "deferred"],
      ["ready", "cancelled"],
      ["in_progress", "drafting"],
      ["in_progress", "deferred"],
      ["in_progress", "cancelled"],
      ["open_pr", "deferred"],
      ["open_pr", "cancelled"],
      ["deferred", "planned"],
    ];

    for (const [from, to] of allowed) {
      it(`permits ${from} → ${to}`, () => {
        const harness = makeController(from);
        const result = harness.controller.transition("studio-153", { to });
        expect(result.state).toBe(to);
      });
    }
  });

  describe("in_progress → ready delegation", () => {
    it("delegates in_progress → ready to ExecutionService.transitionInProgressToReady", () => {
      const harness = makeController("in_progress");

      const result = harness.controller.transition("studio-153", { to: "ready" });

      expect(harness.executionService.transitionInProgressToReady).toHaveBeenCalledWith("studio-153");
      expect(harness.workItemsService.update).not.toHaveBeenCalled();
      expect(result.state).toBe("ready");
    });
  });

  describe("cancelled delegation (ADR 014 step 7)", () => {
    // * → cancelled now delegates to ExecutionService.cancelWorkItem so the
    // plan dir can be archived and the active-run guard runs before the
    // state update.
    const sources: WorkItemState[] = ["planned", "drafting", "ready", "in_progress", "open_pr"];
    for (const from of sources) {
      it(`delegates ${from} → cancelled to ExecutionService.cancelWorkItem`, () => {
        const harness = makeController(from);

        const result = harness.controller.transition("studio-153", { to: "cancelled" });

        expect(harness.executionService.cancelWorkItem).toHaveBeenCalledWith("studio-153");
        expect(harness.workItemsService.update).not.toHaveBeenCalled();
        expect(result.state).toBe("cancelled");
      });
    }
  });

  describe("rejection of disallowed transitions", () => {
    const disallowed: Array<[WorkItemState, WorkItemState]> = [
      ["planned", "in_progress"], // must launch, not manually set
      ["planned", "done"],
      ["done", "planned"],
      ["merged_pr", "done"], // disposition flow (step 7) uses dedicated endpoints, not this allowlist
      ["cancelled", "planned"],
      ["ready", "in_progress"], // must launch, not manually set
    ];

    for (const [from, to] of disallowed) {
      it(`rejects ${from} → ${to}`, () => {
        const harness = makeController(from);
        expect(() => harness.controller.transition("studio-153", { to })).toThrow(
          BadRequestException,
        );
      });
    }
  });

  describe("input validation", () => {
    it("rejects a missing `to` field", () => {
      const harness = makeController("planned");
      expect(() => harness.controller.transition("studio-153", {} as { to: WorkItemState })).toThrow(
        /to.*required/,
      );
    });
  });
});

describe("state-transitions helpers", () => {
  it("isValidHumanTransition returns true for allowed pairs", () => {
    expect(isValidHumanTransition("planned", "drafting")).toBe(true);
    expect(isValidHumanTransition("drafting", "ready")).toBe(true);
    expect(isValidHumanTransition("in_progress", "ready")).toBe(true);
  });

  it("isValidHumanTransition returns false for disallowed pairs", () => {
    expect(isValidHumanTransition("planned", "in_progress")).toBe(false);
    expect(isValidHumanTransition("done", "planned")).toBe(false);
    expect(isValidHumanTransition("merged_pr", "done")).toBe(false);
  });

  it("VALID_HUMAN_TRANSITIONS has no entries for terminal states", () => {
    expect(VALID_HUMAN_TRANSITIONS.done).toHaveLength(0);
    expect(VALID_HUMAN_TRANSITIONS.cancelled).toHaveLength(0);
    expect(VALID_HUMAN_TRANSITIONS.merged_pr).toHaveLength(0);
  });
});
