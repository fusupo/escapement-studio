import { describe, expect, it } from "vitest";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionSafetyCheck } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

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
});
