import { Inject, Injectable } from "@nestjs/common";
import { GraphService } from "../graph/graph.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { getDefaultWorkingBranch, listDefaultWorkingBranches } from "./default-working-branches.js";
import type {
  ExecutionDispatchGroupPreview,
  ExecutionDispatchNodePreview,
  ExecutionDispatchPreview,
  ExecutionLaunchEligibility,
  ExecutionSafetyCheck,
} from "./types.js";
import { WorktreeService } from "./worktree.service.js";

@Injectable()
export class LaunchEligibilityService {
  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
  ) {}

  getPreview(repo?: string): ExecutionDispatchPreview {
    const plan = this.graphService.getPlan(repo);
    const groups: ExecutionDispatchGroupPreview[] = plan.parallel_groups.map((group, index) => ({
      group_id: `group_${index + 1}`,
      repo: group.repo,
      merge_order: group.merge_order,
      nodes: group.nodes.map((node) => {
        const workItem = this.safeGetWorkItem(node.id);
        if (!workItem) {
          const repoValue = group.repo === "unknown" ? null : group.repo;
          const defaultBaseRef = getDefaultWorkingBranch(repoValue);
          const worktreePath = this.worktreeService.getWorktreePath(node.branch);
          const safetyChecks: ExecutionSafetyCheck[] = [{
            code: "missing_work_item",
            status: "fail",
            message: `Work item ${node.id} could not be loaded from the graph store.`,
          }];
          return {
            id: node.id,
            name: node.name,
            repo: repoValue,
            branch: node.branch,
            issue_url: node.issue_url,
            scope_hint: null,
            default_base_ref: defaultBaseRef,
            files_owned: node.files_owned,
            files_shared: node.files_shared,
            files_forbidden: node.files_forbidden,
            worktree_path: worktreePath,
            safety_checks: safetyChecks,
            can_launch: false,
            issue_backed: false,
            launch_unavailable_code: "missing_work_item",
            launch_unavailable_reason: safetyChecks[0].message,
          } satisfies ExecutionDispatchNodePreview;
        }

        const eligibility = this.resolveLaunchEligibility(workItem, { baseRef: getDefaultWorkingBranch(workItem.repo), plan });
        if (eligibility.dispatch_node) {
          return eligibility.dispatch_node;
        }

        const fallbackChecks: ExecutionSafetyCheck[] = [{
          code: "not_dispatchable",
          status: "fail",
          message: "Work item is not currently dispatchable from the frontier.",
        }];
        return {
          id: node.id,
          name: node.name,
          repo: workItem.repo,
          branch: node.branch,
          issue_url: node.issue_url,
          scope_hint: workItem.scope_hint,
          default_base_ref: getDefaultWorkingBranch(workItem.repo),
          files_owned: node.files_owned,
          files_shared: node.files_shared,
          files_forbidden: node.files_forbidden,
          worktree_path: this.worktreeService.getWorktreePath(node.branch),
          safety_checks: fallbackChecks,
          can_launch: false,
          issue_backed: workItem.kind === "issue",
          launch_unavailable_code: fallbackChecks[0].code,
          launch_unavailable_reason: fallbackChecks[0].message,
        } satisfies ExecutionDispatchNodePreview;
      // Planned nodes still belong to the graph planning frontier, but the
      // Execute queue starts at the approved-plan boundary. Keep approved
      // nodes with other safety failures visible as blocked diagnostics.
      }).filter((node) => node.launch_unavailable_code !== "not_ready"),
    })).filter((group) => group.nodes.length > 0);

    const dispatchableNow = groups.reduce(
      (count, group) => count + group.nodes.filter((node) => node.can_launch).length,
      0,
    );
    return {
      generated_at: plan.generated_at,
      assumptions: [
        ...plan.assumptions,
        `Default working branches: ${JSON.stringify(listDefaultWorkingBranches())}. Fallback: ${getDefaultWorkingBranch(null)}.`,
      ],
      validation_policy: plan.validation_policy,
      summary: {
        ...plan.summary,
        dispatchable_now: dispatchableNow,
      },
      groups,
      blocked: plan.sequential,
    };
  }

  resolveLaunchEligibility(
    workItem: WorkItemRecord,
    options: { baseRef?: string; plan?: ReturnType<GraphService["getPlan"]> } = {},
  ): ExecutionLaunchEligibility {
    const baseRef = options.baseRef?.trim() || getDefaultWorkingBranch(workItem.repo);
    const plan = options.plan ?? this.graphService.getPlan(workItem.repo ?? undefined);
    const groupedNode = this.findPlannedNode(plan, workItem.id);
    const branch = groupedNode?.node.branch ?? workItem.branch ?? `${workItem.id}-branch`;
    const worktreePath = this.worktreeService.getWorktreePath(branch);
    const safetyChecks: ExecutionSafetyCheck[] = [];
    const issueBacked = this.isIssueBacked(workItem);

    if (!groupedNode) {
      safetyChecks.push({
        code: "not_dispatchable",
        status: "fail",
        message: "Work item is not currently dispatchable from the frontier.",
      });
    } else {
      safetyChecks.push(this.checkLaunchableState(workItem));
      safetyChecks.push(...this.worktreeService.evaluateSafety(branch, worktreePath, baseRef));
    }

    const firstFailure = safetyChecks.find((check) => check.status === "fail") ?? null;
    const dispatchNode = groupedNode
      ? this.createDispatchNodePreview(groupedNode.group.repo, groupedNode.node, workItem, baseRef, worktreePath, safetyChecks)
      : null;

    return {
      work_item_id: workItem.id,
      repo: workItem.repo,
      issue_url: workItem.issue_url,
      issue_backed: issueBacked,
      can_launch: firstFailure == null,
      safety_checks: safetyChecks,
      launch_unavailable_code: firstFailure?.code ?? null,
      launch_unavailable_reason: firstFailure?.message ?? null,
      dispatch_node: dispatchNode,
    };
  }

  isLaunchableState(state: WorkItemState): boolean {
    const leaf = state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
    return leaf === "ready";
  }

  private createDispatchNodePreview(
    repo: string,
    node: { id: string; name: string; branch: string; files_owned: string[]; files_shared: Array<{ path: string; assessment: string; confidence: string; notes: string }>; files_forbidden: string[]; issue_url?: string },
    workItem: WorkItemRecord,
    baseRef: string,
    worktreePath: string,
    safetyChecks: ExecutionSafetyCheck[],
  ): ExecutionDispatchNodePreview {
    const firstFailure = safetyChecks.find((check) => check.status === "fail") ?? null;
    return {
      id: node.id,
      name: node.name,
      repo: repo === "unknown" ? null : repo,
      branch: node.branch,
      issue_url: node.issue_url,
      scope_hint: workItem.scope_hint,
      default_base_ref: baseRef,
      files_owned: node.files_owned,
      files_shared: node.files_shared,
      files_forbidden: node.files_forbidden,
      worktree_path: worktreePath,
      safety_checks: safetyChecks,
      can_launch: firstFailure == null,
      issue_backed: this.isIssueBacked(workItem),
      launch_unavailable_code: firstFailure?.code ?? null,
      launch_unavailable_reason: firstFailure?.message ?? null,
    };
  }

  private findPlannedNode(plan: ReturnType<GraphService["getPlan"]>, workItemId: string): { group: ReturnType<GraphService["getPlan"]>["parallel_groups"][number]; node: ReturnType<GraphService["getPlan"]>["parallel_groups"][number]["nodes"][number] } | null {
    for (const group of plan.parallel_groups) {
      const node = group.nodes.find((candidate) => candidate.id === workItemId);
      if (node) {
        return { group, node };
      }
    }
    return null;
  }

  private checkLaunchableState(workItem: WorkItemRecord): ExecutionSafetyCheck {
    if (this.isLaunchableState(workItem.state)) {
      return {
        code: "launchable_state",
        status: "pass",
        message: `Work item state '${workItem.state}' is launchable.`,
      };
    }
    return {
      code: "not_ready",
      status: "fail",
      message:
        `Work item state '${workItem.state}' is not launchable. ` +
        "Prepare and approve the plan first; expected 'ready'.",
    };
  }

  private isIssueBacked(workItem: WorkItemRecord): boolean {
    return workItem.kind === "issue";
  }

  private safeGetWorkItem(id: string): WorkItemRecord | null {
    try {
      return this.workItemsService.get(id);
    } catch {
      return null;
    }
  }
}
