import { Inject, Injectable } from "@nestjs/common";
import type { WorkItemRecord } from "../graph/types.js";
import { SubAgentService } from "../planning/sub-agent.service.js";
import type { SubAgentRunRecord } from "../planning/types.js";
import type {
  PlanPreparationAggregate,
  PlanPreparationContributor,
  PlanPreparationTask,
} from "./types.js";

export class PlanPreparationError extends Error {
  constructor(workItemId: string) {
    super(`Plan preparation produced no completed specialist results for ${workItemId}`);
    this.name = "PlanPreparationError";
  }
}

@Injectable()
export class PlanPreparationService {
  constructor(
    @Inject(SubAgentService) private readonly subAgentService: SubAgentService,
  ) {}

  async prepare(workItem: WorkItemRecord): Promise<PlanPreparationAggregate> {
    const tasks = this.buildTasks(workItem);
    // Construct every promise before awaiting so both bounded investigations
    // overlap. Promise.all retains task declaration order.
    const runs = await Promise.all(tasks.map((task) => this.subAgentService.runDelegation({
      agent_type: task.agent_type,
      task: task.task,
      repo: task.repo,
      focus_paths: task.focus_paths,
      work_item_ids: task.work_item_ids,
      notes: task.notes,
    })));
    const contributors = runs.map((run, index) => this.toContributor(tasks[index], run));

    if (!contributors.some((contributor) => contributor.status === "completed")) {
      throw new PlanPreparationError(workItem.id);
    }

    return {
      contributors,
      degraded: contributors.some((contributor) => contributor.degraded),
    };
  }

  private buildTasks(workItem: WorkItemRecord): PlanPreparationTask[] {
    const focusPaths = this.normalizeFocusPaths(workItem.predicted_files);
    const focusNote = focusPaths.length > 0
      ? "Treat the supplied focus paths as starting points; inspect only directly relevant dependencies."
      : "No predicted focus paths are available; identify a minimal bounded set from the issue context.";
    const context = [workItem.name, workItem.scope_hint].filter(Boolean).join(" — ");

    return [
      {
        agent_type: "code-crawler",
        task: `Trace concrete implementation paths for ${workItem.id}: ${context}`,
        repo: workItem.repo ?? undefined,
        focus_paths: focusPaths,
        work_item_ids: [workItem.id],
        notes: `${focusNote} Report concrete files, entrypoints, dependencies, and test patterns.`,
      },
      {
        agent_type: "scope-predictor",
        task: `Predict bounded implementation impact and risks for ${workItem.id}: ${context}`,
        repo: workItem.repo ?? undefined,
        focus_paths: focusPaths,
        work_item_ids: [workItem.id],
        notes: `${focusNote} Report likely files/modules, dependencies, risks, and uncertainty.`,
      },
    ];
  }

  private normalizeFocusPaths(paths: string[]): string[] {
    return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  }

  private toContributor(
    task: PlanPreparationTask,
    run: SubAgentRunRecord,
  ): PlanPreparationContributor {
    const result = run.result;
    const completed = run.status === "completed" && result?.status === "completed";
    const confidence = result?.confidence ?? "low";
    const errors = result?.errors ?? (completed ? [] : [{
      code: "missing_result",
      message: "Specialist run did not return a completed result envelope.",
    }]);

    return {
      task,
      run_id: run.run_id,
      status: completed ? "completed" : "error",
      confidence,
      summary: result?.summary ?? run.progress_message ?? "Specialist run produced no summary.",
      findings: result?.findings ?? [],
      open_questions: result?.open_questions ?? [],
      errors,
      degraded: !completed || confidence === "low",
    };
  }
}
