import { describe, expect, it, vi } from "vitest";
import { HsmActionHandlers, type HsmActionContext, type WorkItemHsmEvent } from "../hsm-action-handlers.js";
import { HsmGuardHandlers } from "../hsm-guard-handlers.js";
import { WorkItemHsmService } from "../work-item-hsm.service.js";
import type { WorkItemRecord, WorkItemState } from "../types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-202",
    name: "HSM action handler wiring",
    kind: "issue",
    state: "planned",
    repo: "fusupo/escapement-studio",
    issue_number: 202,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/202",
    scope_hint: null,
    branch: "studio-202-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeHarness(initialState: WorkItemState = "planned") {
  let current = makeWorkItem({ state: initialState });
  const workItemsService = {
    get: vi.fn(() => current),
    update: vi.fn((_id: string, patch: Partial<WorkItemRecord>) => {
      current = { ...current, ...patch, meta: patch.meta ?? current.meta };
      return current;
    }),
  };

  const actions = Object.create(HsmActionHandlers.prototype) as HsmActionHandlers;
  actions.createRunRecord = vi.fn(async () => ({ output: { run_id: "exec_1" } }));
  actions.stampMeta = vi.fn((blockName: string) => async (ctx: HsmActionContext) => ({
    patch: {
      meta: {
        ...ctx.workItem.meta,
        [blockName]: { at: ctx.now(), ...(ctx.event.payload ?? {}) },
      },
    },
  }));
  actions.closeGhIssue = vi.fn(async () => ({}));
  actions.runArchiver = vi.fn(async () => ({ patch: { archive_path: "/tmp/archive/studio-202" } }));
  actions.kickOffPlanDrafter = vi.fn(() => ({ completion: Promise.resolve(), cancel: vi.fn(), sessionId: "draft-1" }));

  const guards = Object.create(HsmGuardHandlers.prototype) as HsmGuardHandlers;
  guards.prExistsForBranch = vi.fn(async () => true);

  const service = new WorkItemHsmService(
    workItemsService as never,
    actions,
    guards,
  );

  return { service, actions, guards, workItemsService, getCurrent: () => current };
}

describe("WorkItemHsmService", () => {
  it("starts the drafter invoke on planned -> drafting", async () => {
    const harness = makeHarness("planned");

    const result = await harness.service.dispatch("studio-202", { type: "user.start_draft" });

    expect(result.nextState).toBe("drafting");
    expect(harness.actions.kickOffPlanDrafter).toHaveBeenCalledTimes(1);
  });

  it("routes run.completed through the PR-existence guard", async () => {
    const harness = makeHarness("in_progress");

    const result = await harness.service.dispatch("studio-202", { type: "run.completed" });

    expect(harness.guards.prExistsForBranch).toHaveBeenCalledTimes(1);
    expect(result.nextState).toBe("open_pr");
  });

  it("applies the merged-pr entry action registry", async () => {
    const harness = makeHarness("open_pr");
    const event: WorkItemHsmEvent = {
      type: "gh.pr_merged",
      payload: { pull_request: { number: 202, url: "https://example.test/pr/202" } },
    };

    const result = await harness.service.dispatch("studio-202", event);

    expect(result.nextState).toBe("merged_pr");
    expect(harness.actions.stampMeta).toHaveBeenCalledWith("studio_post_merge_sync");
    expect(harness.getCurrent().meta).toHaveProperty("studio_post_merge_sync");
  });
});
