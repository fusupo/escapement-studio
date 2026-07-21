import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphEventsService } from "../graph-events.service.js";
import { GraphWriterService } from "../graph-writer.service.js";
import { WorkItemHsmService } from "../work-item-hsm.service.js";
import type { DispatchResult, WorkItemHsmEvent, WorkItemRecord, WorkItemState } from "../types.js";
import { WorkItemsService } from "../work-items.service.js";

function makeWorkItem(state: WorkItemState, meta: Record<string, unknown> = {}): WorkItemRecord {
  return {
    id: "studio-200",
    name: "HSM test",
    kind: "issue",
    state,
    repo: "fusupo/escapement-studio",
    issue_number: 200,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/200",
    scope_hint: null,
    branch: "studio-200-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta,
    updated_at: "2026-04-12T00:00:00Z",
  };
}

function createHarness(initialState: WorkItemState, meta: Record<string, unknown> = {}) {
  let current = makeWorkItem(initialState, meta);

  const workItems = {
    get: vi.fn(() => current),
  } as unknown as WorkItemsService;

  const graphWriter = {
    apply: vi.fn(({ mutations }: { mutations: Array<{ id: string; patch: Partial<WorkItemRecord> }> }) => {
      const patch = mutations[0]?.patch ?? {};
      current = { ...current, ...patch };
      return {
        status: "applied",
        proposal_id: null,
        applied_mutation_ids: ["u1"],
        previous_graph_version: "0",
        new_graph_version: "1",
      };
    }),
  } as unknown as GraphWriterService;

  const graphEvents = {
    emitWorkItemStateChanged: vi.fn(),
  } as unknown as GraphEventsService;

  const service = new WorkItemHsmService(workItems, graphWriter, graphEvents);
  service.onModuleInit();

  return {
    service,
    graphWriter,
    graphEvents,
    getCurrent: () => current,
  };
}

describe("WorkItemHsmService", () => {
  const loggerDebugSpy = vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);

  beforeEach(() => {
    loggerDebugSpy.mockClear();
  });

  afterEach(() => {
    loggerDebugSpy.mockClear();
  });

  it("parses the canonical SCXML chart on module init", () => {
    const harness = createHarness("planned");
    expect(harness.service.getEnabledEvents("studio-200")).toContain("user.start_draft");
  });

  it("fails loudly on malformed SCXML", () => {
    const service = new WorkItemHsmService({ get: vi.fn() } as unknown as WorkItemsService, {
      apply: vi.fn(),
    } as unknown as GraphWriterService, {
      emitWorkItemStateChanged: vi.fn(),
    } as unknown as GraphEventsService);

    Object.defineProperty(service, "chartPath", { value: __filename, writable: false });
    expect(() => service.onModuleInit()).toThrow();
  });

  it("dispatches user.start_draft from planned to pre_pr.drafting with one update mutation", async () => {
    const harness = createHarness("planned");

    const result = await harness.service.dispatch("studio-200", { type: "user.start_draft" });

    expect(result.next_state).toBe("pre_pr.drafting");
    expect(result.mutation_applied).toBe(true);
    expect((harness.graphWriter.apply as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((harness.graphWriter.apply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      mutations: [{ kind: "update_work_item", id: "studio-200", patch: { state: "pre_pr.drafting" } }],
    });
  });

  it("rejects illegal events without mutation and logs a debug rejection", async () => {
    const harness = createHarness("planned");

    const result = await harness.service.dispatch("studio-200", { type: "user.finalize" });

    expect(result.rejected).toBe(true);
    expect(result.mutation_applied).toBe(false);
    expect(harness.graphWriter.apply).not.toHaveBeenCalled();
    expect(harness.graphEvents.emitWorkItemStateChanged).not.toHaveBeenCalled();
    expect(loggerDebugSpy).toHaveBeenCalledWith(expect.stringContaining("rejected by HSM"));
  });

  it("rehydrates from pre_pr.in_progress and opens a PR state with stamped meta", async () => {
    const harness = createHarness("pre_pr.in_progress");

    const result = await harness.service.dispatch("studio-200", {
      type: "run.completed",
      run_id: "run-1",
      pr_exists: true,
    });

    expect(result.next_state).toBe("open_pr");
    expect(result.applied_actions).toContain("stampMeta:studio_open_pr_sync");
    expect(harness.getCurrent().meta).toMatchObject({
      studio_open_pr_sync: {
        source_event: "run.completed",
      },
    });
  });

  it("returns the enabled user events for merged_pr", () => {
    const harness = createHarness("merged_pr");
    expect(harness.service.getEnabledEvents("studio-200")).toEqual([
      "user.finalize",
      "user.archive_and_finalize",
    ]);
  });

  it("keeps post-close archival available from done", () => {
    const harness = createHarness("done");
    expect(harness.service.getEnabledEvents("studio-200")).toEqual([
      "user.archive_and_finalize",
    ]);
  });

  const transitionCases: Array<[WorkItemState, WorkItemHsmEvent, WorkItemState]> = [
    ["planned", { type: "user.start_draft" }, "pre_pr.drafting"],
    ["pre_pr.drafting", { type: "draft.completed" }, "pre_pr.ready"],
    ["pre_pr.drafting", { type: "draft.failed", reason: "boom" }, "pre_pr.run_errored"],
    ["pre_pr.ready", { type: "user.dispatch" }, "pre_pr.in_progress"],
    ["pre_pr.in_progress", { type: "run.error", run_id: "r1", reason: "boom" }, "pre_pr.run_errored"],
    ["pre_pr.run_errored", { type: "user.retry" }, "pre_pr.in_progress"],
    ["pre_pr.run_errored", { type: "user.investigate" }, "pre_pr.ready"],
    ["pre_pr.in_progress", { type: "run.completed", run_id: "r2", pr_exists: false }, "merged_pr"],
    ["pre_pr.ready", { type: "user.defer" }, "deferred"],
    ["pre_pr.ready", { type: "user.cancel" }, "cancelled"],
    ["open_pr", { type: "gh.pr_merged", pull_request: { number: 7 } }, "merged_pr"],
    ["open_pr", { type: "gh.issue_closed", issue: { number: 200 } }, "closed"],
    ["merged_pr", { type: "user.finalize" }, "done"],
    ["merged_pr", { type: "user.archive_and_finalize" }, "archived"],
    ["closed", { type: "user.finalize" }, "done"],
    ["closed", { type: "user.archive_and_finalize" }, "archived"],
    ["done", { type: "user.archive_and_finalize" }, "archived"],
  ];

  it.each(transitionCases)("transitions %s via %o to %s", async (from, event, expected) => {
    const harness = createHarness(from);
    const result = await harness.service.dispatch("studio-200", event);
    expect(result.next_state).toBe(expected);
  });

  it("emits a graph state-change event when a transition applies", async () => {
    const harness = createHarness("planned");

    await harness.service.dispatch("studio-200", { type: "user.start_draft" });

    expect(harness.graphEvents.emitWorkItemStateChanged).toHaveBeenCalledWith({
      work_item_id: "studio-200",
      prev_state: "pre_pr.planned",
      next_state: "pre_pr.drafting",
      event_type: "user.start_draft",
      timestamp: expect.any(String),
    });
  });

  it("restores pre_pr history on user.undefer", async () => {
    const harness = createHarness("deferred", {
      studio_hsm: {
        deferred_from_state: "pre_pr.ready",
      },
    });

    const result = await harness.service.dispatch("studio-200", { type: "user.undefer" });

    expect(result.next_state).toBe("pre_pr.ready");
    expect(harness.getCurrent().meta).toMatchObject({ studio_hsm: {} });
  });

  describe("action handler registry (studio-196)", () => {
    it("registered async handler is called during dispatch", async () => {
      const harness = createHarness("merged_pr");
      const handler = vi.fn(async () => {});
      harness.service.registerActionHandler("closeGhIssue", handler);

      await harness.service.dispatch("studio-200", { type: "user.finalize" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: "studio-200" }),
        { type: "user.finalize" },
        expect.objectContaining({ meta: expect.any(Object), handler_data: expect.any(Object) }),
      );
    });

    it("handler that throws prevents state write", async () => {
      const harness = createHarness("merged_pr");
      harness.service.registerActionHandler("closeGhIssue", async () => {
        throw new Error("gh close failed");
      });

      await expect(harness.service.dispatch("studio-200", { type: "user.finalize" })).rejects.toThrow(
        "gh close failed",
      );

      // State unchanged — graphWriter.apply never called
      expect(harness.graphWriter.apply).not.toHaveBeenCalled();
      expect(harness.getCurrent().state).toBe("merged_pr");
    });

    it("handler_data populated by handler is returned in DispatchResult", async () => {
      const harness = createHarness("merged_pr");
      harness.service.registerActionHandler("closeGhIssue", async (_wi, _ev, ctx) => {
        ctx.handler_data.closed_issue = { repo: "test/repo", number: 42 };
      });

      const result = await harness.service.dispatch("studio-200", { type: "user.finalize" });

      expect(result.handler_data).toEqual({ closed_issue: { repo: "test/repo", number: 42 } });
    });

    it("patch_overrides from handler are merged into the mutation", async () => {
      const harness = createHarness("merged_pr");
      harness.service.registerActionHandler("runArchiver", async (_wi, _ev, ctx) => {
        ctx.patch_overrides.archive_path = "/archives/studio-200";
      });

      // Use archive_and_finalize which triggers runArchiver (and closeGhIssue on merged_pr)
      harness.service.registerActionHandler("closeGhIssue", async () => {});
      await harness.service.dispatch("studio-200", { type: "user.archive_and_finalize" });

      const appliedCall = (harness.graphWriter.apply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(appliedCall.mutations[0].patch).toMatchObject({
        state: "archived",
        archive_path: "/archives/studio-200",
      });
    });

    it("archives from done without invoking the GitHub close action", async () => {
      const harness = createHarness("done");
      const closeGhIssue = vi.fn(async () => {});
      const runArchiver = vi.fn(async (_wi, _ev, ctx) => {
        ctx.patch_overrides.archive_path = "/archives/studio-200";
      });
      harness.service.registerActionHandler("closeGhIssue", closeGhIssue);
      harness.service.registerActionHandler("runArchiver", runArchiver);

      const result = await harness.service.dispatch("studio-200", {
        type: "user.archive_and_finalize",
      });

      expect(result.next_state).toBe("archived");
      expect(result.applied_actions).toEqual(["runArchiver"]);
      expect(runArchiver).toHaveBeenCalledOnce();
      expect(closeGhIssue).not.toHaveBeenCalled();
      expect(harness.getCurrent()).toMatchObject({
        state: "archived",
        archive_path: "/archives/studio-200",
      });
    });

    it("throws when registering a duplicate handler name", () => {
      const harness = createHarness("planned");
      harness.service.registerActionHandler("closeGhIssue", async () => {});
      expect(() => harness.service.registerActionHandler("closeGhIssue", async () => {})).toThrow(
        /already registered/,
      );
    });

    it("handler_data is undefined when no handler populates it", async () => {
      const harness = createHarness("planned");
      const result = await harness.service.dispatch("studio-200", { type: "user.start_draft" });
      expect(result.handler_data).toBeUndefined();
    });
  });
});
