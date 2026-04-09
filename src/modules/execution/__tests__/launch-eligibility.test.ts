import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionSafetyCheck } from "../types.js";
import type { WorkItemRecord, WorkItemState } from "../../graph/types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-141",
    name: "Gate launch actions to frontier nodes",
    kind: "issue",
    state: "planned",
    repo: "fusupo/escapement-studio",
    issue_number: 141,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/141",
    scope_hint: "Only allow launch for dispatchable frontier items.",
    branch: "studio-141-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function makePlanNode(id: string, name: string, branch: string) {
  return {
    id,
    name,
    branch,
    issue_url: `https://github.com/fusupo/escapement-studio/issues/${id.replace("studio-", "")}`,
    files_owned: ["src/example.ts"],
    files_shared: [],
    files_forbidden: ["src/forbidden.ts"],
  };
}

function makePlan(nodes: Array<ReturnType<typeof makePlanNode>>) {
  return {
    generated_at: "2026-04-09T00:00:00.000Z",
    assumptions: [],
    parallel_groups: [{ repo: "fusupo/escapement-studio", nodes }],
    sequential: [],
    validation_policy: {
      max_concurrent_node_heavy_tasks: 1,
      serialized_checks: [],
    },
    summary: {
      frontier_count: nodes.length,
      dispatchable_now: nodes.length,
      blocked_count: 0,
      human_gate_count: 0,
    },
  };
}

function makeService(params: {
  workItems: WorkItemRecord[];
  plan: ReturnType<typeof makePlan>;
  safetyChecks?: ExecutionSafetyCheck[];
}): ExecutionService {
  const service = Object.create(ExecutionService.prototype) as ExecutionService;
  const workItemsById = new Map(params.workItems.map((item) => [item.id, item]));

  (service as any).graphService = {
    getPlan: () => params.plan,
  };
  (service as any).workItemsService = {
    get: (id: string) => {
      const item = workItemsById.get(id);
      if (!item) {
        throw new Error(`Unknown work item: ${id}`);
      }
      return item;
    },
  };
  (service as any).worktreeRoot = "/tmp/studio-worktrees";
  (service as any).evaluateSafety = () => params.safetyChecks ?? [{ code: "base_ref_exists", status: "pass", message: "Base ref exists." }];

  return service;
}

function makeLaunchHarness(workItem: WorkItemRecord, options: { canLaunch?: boolean } = {}) {
  const service = Object.create(ExecutionService.prototype) as ExecutionService;
  const updateCalls: Array<{ id: string; patch: Partial<WorkItemRecord> }> = [];
  const executionOrder: string[] = [];
  let currentWorkItem = workItem;

  (service as any).workItemsService = {
    get: (id: string) => {
      if (id !== currentWorkItem.id) {
        throw new Error(`Unknown work item: ${id}`);
      }
      return currentWorkItem;
    },
    update: (id: string, patch: Partial<WorkItemRecord>) => {
      updateCalls.push({ id, patch });
      currentWorkItem = {
        ...currentWorkItem,
        ...patch,
        updated_at: "2026-04-09T00:00:01.000Z",
      };
      executionOrder.push(`update:${id}:${patch.state ?? "unknown"}`);
      return currentWorkItem;
    },
  };

  (service as any).resolveLaunchEligibility = () => {
    if (options.canLaunch === false) {
      return {
        can_launch: false,
        safety_checks: [{ code: "not_dispatchable", status: "fail", message: "Blocked" }],
        launch_unavailable_code: "not_dispatchable",
        launch_unavailable_reason: "Blocked",
        dispatch_node: null,
      };
    }

    return {
      can_launch: true,
      safety_checks: [{ code: "base_ref_exists", status: "pass", message: "Base ref exists." }],
      launch_unavailable_code: null,
      launch_unavailable_reason: null,
      dispatch_node: {
        id: currentWorkItem.id,
        name: currentWorkItem.name,
        repo: currentWorkItem.repo,
        branch: currentWorkItem.branch ?? `${currentWorkItem.id}-branch`,
        issue_url: currentWorkItem.issue_url ?? undefined,
        scope_hint: currentWorkItem.scope_hint,
        default_base_ref: "develop",
        files_owned: ["src/example.ts"],
        files_shared: [],
        files_forbidden: [],
        worktree_path: `/tmp/studio-worktrees/${currentWorkItem.branch ?? `${currentWorkItem.id}-branch`}`,
        safety_checks: [{ code: "base_ref_exists", status: "pass", message: "Base ref exists." }],
        can_launch: true,
        issue_backed: currentWorkItem.kind === "issue",
        launch_unavailable_code: null,
        launch_unavailable_reason: null,
      },
    };
  };

  (service as any).worktreeRoot = "/tmp/studio-worktrees";

  // ADR 014 step 5: launch() now calls appendRunIdToPlanMetadata after
  // persisting the run. Stub it to a no-op so these tests don't need to
  // wire up plan metadata on the filesystem.
  (service as any).appendRunIdToPlanMetadata = vi.fn();
  (service as any).createRunRecord = vi.fn(({ workItem: nextWorkItem, branch, baseRef, worktreePath, prompt, status, safetyChecks, errors }) => ({
    run_id: "exec_123",
    run_type: "execution",
    work_item_id: nextWorkItem.id,
    work_item_name: nextWorkItem.name,
    status,
    created_at: "2026-04-09T00:00:00.000Z",
    updated_at: "2026-04-09T00:00:00.000Z",
    repo: nextWorkItem.repo,
    issue_url: nextWorkItem.issue_url,
    branch,
    base_ref: baseRef,
    worktree_path: worktreePath,
    artifact_dir: "/tmp/runs/exec_123",
    prompt,
    activity_log: [],
    safety_checks: safetyChecks,
    errors,
  }));
  (service as any).persistRun = vi.fn();
  (service as any).emitRun = vi.fn();
  (service as any).pushActivity = vi.fn((_runId: string, _kind: string, message: string) => {
    executionOrder.push(`activity:${message}`);
  });
  (service as any).executeRun = vi.fn(async () => {
    executionOrder.push("executeRun");
  });
  (service as any).buildPrompt = vi.fn(() => "prompt");

  return {
    service,
    updateCalls,
    executionOrder,
    getCurrentWorkItem: () => currentWorkItem,
  };
}

describe("launch eligibility", () => {
  it("allows launch for issue-backed frontier work items", () => {
    const workItem = makeWorkItem();
    const service = makeService({
      workItems: [workItem],
      plan: makePlan([makePlanNode(workItem.id, workItem.name, workItem.branch ?? "studio-141-branch")]),
    });

    const eligibility = service.getLaunchEligibility(workItem.id);

    expect(eligibility.can_launch).toBe(true);
    expect(eligibility.issue_backed).toBe(true);
    expect(eligibility.launch_unavailable_code).toBeNull();
    expect(eligibility.dispatch_node?.can_launch).toBe(true);
    expect(eligibility.dispatch_node?.issue_backed).toBe(true);
  });

  it("allows launch for frontier capability items when they are dispatchable", () => {
    const workItem = makeWorkItem({
      id: "capability-1",
      kind: "capability",
      issue_number: null,
      issue_url: null,
      branch: "capability-1-branch",
    });
    const service = makeService({
      workItems: [workItem],
      plan: makePlan([makePlanNode(workItem.id, workItem.name, workItem.branch ?? "capability-1-branch")]),
    });

    const eligibility = service.getLaunchEligibility(workItem.id);

    expect(eligibility.can_launch).toBe(true);
    expect(eligibility.issue_backed).toBe(false);
    expect(eligibility.launch_unavailable_code).toBeNull();
    expect(eligibility.launch_unavailable_reason).toBeNull();
    expect(eligibility.dispatch_node?.can_launch).toBe(true);
  });

  it("blocks launch for non-frontier work items", () => {
    const workItem = makeWorkItem({ id: "studio-142", branch: "studio-142-branch" });
    const service = makeService({
      workItems: [workItem],
      plan: makePlan([]),
    });

    const eligibility = service.getLaunchEligibility(workItem.id);

    expect(eligibility.can_launch).toBe(false);
    expect(eligibility.launch_unavailable_code).toBe("not_dispatchable");
    expect(eligibility.launch_unavailable_reason).toContain("dispatchable");
    expect(eligibility.dispatch_node).toBeNull();
  });

  it("reuses shared eligibility logic when building the execution preview", () => {
    const workItem = makeWorkItem({
      id: "capability-2",
      kind: "capability",
      issue_number: null,
      issue_url: null,
      branch: "capability-2-branch",
    });
    const service = makeService({
      workItems: [workItem],
      plan: makePlan([makePlanNode(workItem.id, workItem.name, workItem.branch ?? "capability-2-branch")]),
    });

    const preview = service.getPreview();
    const node = preview.groups[0]?.nodes[0];

    expect(node).toBeTruthy();
    expect(node.can_launch).toBe(true);
    expect(node.issue_backed).toBe(false);
    expect(node.launch_unavailable_code).toBeNull();
    expect(node.launch_unavailable_reason).toBeNull();
  });

  it("marks planned work items in progress before launching execution", async () => {
    const workItem = makeWorkItem();
    const harness = makeLaunchHarness(workItem);

    const result = await harness.service.launch({ work_item_id: workItem.id, prompt: "Launch" });

    expect(result.accepted).toBe(true);
    expect(harness.updateCalls).toEqual([{ id: workItem.id, patch: { state: "in_progress" } }]);
    expect(harness.getCurrentWorkItem().state).toBe("in_progress");
    expect(harness.executionOrder).toEqual([
      `update:${workItem.id}:in_progress`,
      "activity:Execution run queued. Work item state updated to in_progress.",
      "executeRun",
    ]);
  });

  it("marks ready work items in progress before launching execution (ADR 014 step 3)", async () => {
    const workItem = makeWorkItem({ state: "ready" });
    const harness = makeLaunchHarness(workItem);

    const result = await harness.service.launch({ work_item_id: workItem.id, prompt: "Launch" });

    expect(result.accepted).toBe(true);
    expect(harness.updateCalls).toEqual([{ id: workItem.id, patch: { state: "in_progress" } }]);
    expect(harness.getCurrentWorkItem().state).toBe("in_progress");
    expect(harness.executionOrder).toEqual([
      `update:${workItem.id}:in_progress`,
      "activity:Execution run queued. Work item state updated to in_progress.",
      "executeRun",
    ]);
  });

  it("does not re-mark work items already in progress when launching execution", async () => {
    const workItem = makeWorkItem({ state: "in_progress" });
    const harness = makeLaunchHarness(workItem);

    const result = await harness.service.launch({ work_item_id: workItem.id, prompt: "Launch" });

    expect(result.accepted).toBe(true);
    expect(harness.updateCalls).toEqual([]);
    expect(harness.getCurrentWorkItem().state).toBe("in_progress");
    expect(harness.executionOrder).toEqual([
      "activity:Execution run queued.",
      "executeRun",
    ]);
  });

  it("does not change graph state for blocked launches", async () => {
    const workItem = makeWorkItem();
    const harness = makeLaunchHarness(workItem, { canLaunch: false });

    const result = await harness.service.launch({ work_item_id: workItem.id, prompt: "Launch" });

    expect(result.accepted).toBe(false);
    expect(result.run.status).toBe("blocked");
    expect(harness.updateCalls).toEqual([]);
    expect(harness.getCurrentWorkItem().state).toBe("planned");
    expect(harness.executionOrder).toEqual([]);
  });

  // ADR 014 step 5: the `not_ready` safety check gates launch on work item state.
  describe("launchable_state safety check (ADR 014 step 5)", () => {
    const launchableStates: WorkItemState[] = ["ready", "planned"];
    const nonLaunchableStates: WorkItemState[] = [
      "drafting",
      "in_progress",
      "open_pr",
      "merged_pr",
      "done",
      "deferred",
      "cancelled",
    ];

    for (const state of launchableStates) {
      it(`allows launch for ${state} work items`, () => {
        const workItem = makeWorkItem({ state });
        const service = makeService({
          workItems: [workItem],
          plan: makePlan([makePlanNode(workItem.id, workItem.name, workItem.branch ?? "studio-141-branch")]),
        });

        const eligibility = service.getLaunchEligibility(workItem.id);

        expect(eligibility.can_launch).toBe(true);
        expect(eligibility.launch_unavailable_code).toBeNull();
        const launchableCheck = eligibility.safety_checks.find((check: ExecutionSafetyCheck) => check.code === "launchable_state");
        expect(launchableCheck?.status).toBe("pass");
      });
    }

    for (const state of nonLaunchableStates) {
      it(`blocks launch for ${state} work items with not_ready code`, () => {
        const workItem = makeWorkItem({ state });
        const service = makeService({
          workItems: [workItem],
          plan: makePlan([makePlanNode(workItem.id, workItem.name, workItem.branch ?? "studio-141-branch")]),
        });

        const eligibility = service.getLaunchEligibility(workItem.id);

        expect(eligibility.can_launch).toBe(false);
        expect(eligibility.launch_unavailable_code).toBe("not_ready");
        expect(eligibility.launch_unavailable_reason).toContain(state);
        expect(eligibility.launch_unavailable_reason).toContain("not launchable");
        const failing = eligibility.safety_checks.find((check: ExecutionSafetyCheck) => check.code === "not_ready");
        expect(failing?.status).toBe("fail");
      });
    }

    it("does not include the launchable_state check when the work item is off the frontier", () => {
      // When `not_dispatchable` fires, eligibility short-circuits and does not
      // evaluate the launchable_state check. This preserves the simpler
      // not_dispatchable block reason for off-frontier items.
      const workItem = makeWorkItem({ state: "drafting", id: "studio-142", branch: "studio-142-branch" });
      const service = makeService({
        workItems: [workItem],
        plan: makePlan([]),
      });

      const eligibility = service.getLaunchEligibility(workItem.id);

      expect(eligibility.can_launch).toBe(false);
      expect(eligibility.launch_unavailable_code).toBe("not_dispatchable");
      const hasLaunchableCheck = eligibility.safety_checks.some((check: ExecutionSafetyCheck) => check.code === "launchable_state" || check.code === "not_ready");
      expect(hasLaunchableCheck).toBe(false);
    });
  });
});

describe("ExecutionService.transitionInProgressToReady", () => {
  function makeTransitionHarness(workItem: WorkItemRecord) {
    const service = Object.create(ExecutionService.prototype) as ExecutionService;
    const updateCalls: Array<{ id: string; patch: Partial<WorkItemRecord> }> = [];
    let currentWorkItem = workItem;

    (service as any).workItemsService = {
      get: (id: string) => {
        if (id !== currentWorkItem.id) {
          throw new Error(`Unknown work item: ${id}`);
        }
        return currentWorkItem;
      },
      update: (id: string, patch: Partial<WorkItemRecord>) => {
        updateCalls.push({ id, patch });
        currentWorkItem = {
          ...currentWorkItem,
          ...patch,
          updated_at: "2026-04-09T00:00:01.000Z",
        };
        return currentWorkItem;
      },
    };

    return { service, updateCalls, getCurrentWorkItem: () => currentWorkItem };
  }

  it("transitions a work item from in_progress to ready", () => {
    const workItem = makeWorkItem({ state: "in_progress" });
    const harness = makeTransitionHarness(workItem);

    const result = harness.service.transitionInProgressToReady(workItem.id);

    expect(result.state).toBe("ready");
    expect(harness.updateCalls).toEqual([{ id: workItem.id, patch: { state: "ready" } }]);
    expect(harness.getCurrentWorkItem().state).toBe("ready");
  });

  it("throws when the current state is not in_progress", () => {
    const workItem = makeWorkItem({ state: "planned" });
    const harness = makeTransitionHarness(workItem);

    expect(() => harness.service.transitionInProgressToReady(workItem.id)).toThrow(
      /Cannot transition .* from planned to ready/,
    );
    expect(harness.updateCalls).toEqual([]);
  });

  it("throws when the current state is ready (no-op rejection)", () => {
    const workItem = makeWorkItem({ state: "ready" });
    const harness = makeTransitionHarness(workItem);

    expect(() => harness.service.transitionInProgressToReady(workItem.id)).toThrow(
      /Cannot transition .* from ready to ready/,
    );
    expect(harness.updateCalls).toEqual([]);
  });
});

describe("ExecutionService.transitionInProgressToDrafting (ADR 014 step 5)", () => {
  function makeTransitionHarness(workItem: WorkItemRecord) {
    const service = Object.create(ExecutionService.prototype) as ExecutionService;
    const updateCalls: Array<{ id: string; patch: Partial<WorkItemRecord> }> = [];
    let currentWorkItem = workItem;

    (service as any).workItemsService = {
      get: (id: string) => {
        if (id !== currentWorkItem.id) {
          throw new Error(`Unknown work item: ${id}`);
        }
        return currentWorkItem;
      },
      update: (id: string, patch: Partial<WorkItemRecord>) => {
        updateCalls.push({ id, patch });
        currentWorkItem = {
          ...currentWorkItem,
          ...patch,
          updated_at: "2026-04-09T00:00:01.000Z",
        };
        return currentWorkItem;
      },
    };

    return { service, updateCalls, getCurrentWorkItem: () => currentWorkItem };
  }

  it("transitions a work item from in_progress to drafting", () => {
    const workItem = makeWorkItem({ state: "in_progress" });
    const harness = makeTransitionHarness(workItem);

    const result = harness.service.transitionInProgressToDrafting(workItem.id);

    expect(result.state).toBe("drafting");
    expect(harness.updateCalls).toEqual([{ id: workItem.id, patch: { state: "drafting" } }]);
    expect(harness.getCurrentWorkItem().state).toBe("drafting");
  });

  it("throws when the current state is not in_progress (planned)", () => {
    const workItem = makeWorkItem({ state: "planned" });
    const harness = makeTransitionHarness(workItem);

    expect(() => harness.service.transitionInProgressToDrafting(workItem.id)).toThrow(
      /Cannot transition .* from planned to drafting/,
    );
    expect(harness.updateCalls).toEqual([]);
  });

  it("throws when the current state is ready", () => {
    const workItem = makeWorkItem({ state: "ready" });
    const harness = makeTransitionHarness(workItem);

    expect(() => harness.service.transitionInProgressToDrafting(workItem.id)).toThrow(
      /Cannot transition .* from ready to drafting/,
    );
    expect(harness.updateCalls).toEqual([]);
  });

  it("throws when the current state is drafting (no-op rejection)", () => {
    const workItem = makeWorkItem({ state: "drafting" });
    const harness = makeTransitionHarness(workItem);

    expect(() => harness.service.transitionInProgressToDrafting(workItem.id)).toThrow(
      /Cannot transition .* from drafting to drafting/,
    );
    expect(harness.updateCalls).toEqual([]);
  });
});
