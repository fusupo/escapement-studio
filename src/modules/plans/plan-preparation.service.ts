import { Inject, Injectable } from "@nestjs/common";
import type { WorkItemRecord } from "../graph/types.js";
import { SubAgentService } from "../planning/sub-agent.service.js";
import type { SubAgentRunRecord } from "../planning/types.js";
import type {
  PlanPreparationAggregate,
  PlanPreparationContributor,
  PlanPreparationTask,
} from "./types.js";

export function serializePlanPreparationEvidence(preparation?: PlanPreparationAggregate) {
  return preparation?.contributors.map((contributor) => ({
    task: {
      agent_type: contributor.task.agent_type,
      task: contributor.task.task,
      repo: contributor.task.repo ?? null,
      focus_paths: contributor.task.focus_paths,
      work_item_ids: contributor.task.work_item_ids,
    },
    run_id: contributor.run_id,
    status: contributor.status,
    confidence: contributor.confidence,
    degraded: contributor.degraded,
    summary: contributor.summary,
    findings: contributor.findings.map((finding) => ({
      kind: finding.kind,
      ...(finding.file ? { file: finding.file } : {}),
      ...(finding.lines ? { lines: finding.lines } : {}),
      ...(finding.summary ? { summary: finding.summary } : {}),
      ...(finding.snippet ? { snippet: finding.snippet } : {}),
    })),
    open_questions: contributor.open_questions,
    errors: contributor.errors,
  })) ?? [];
}

export function renderPlanPreparationSection(preparation?: PlanPreparationAggregate): string[] {
  if (!preparation) return [];
  return [
    "## Parallel Preparation",
    "",
    `Two bounded specialists contributed to final synthesis${preparation.degraded ? " (degraded)" : ""}.`,
    "",
    ...preparation.contributors.flatMap((contributor) => [
      `### ${contributor.task.agent_type}`,
      "",
      `- **Run ID:** ${contributor.run_id}`,
      `- **Status:** ${contributor.status}${contributor.degraded ? " (degraded)" : ""}`,
      `- **Confidence:** ${contributor.confidence}`,
      `- **Task:** ${contributor.task.task}`,
      `- **Repo:** ${contributor.task.repo ?? "(not set)"}`,
      `- **Work items:** ${contributor.task.work_item_ids.join(", ")}`,
      `- **Focus paths:** ${contributor.task.focus_paths.length ? contributor.task.focus_paths.join(", ") : "(none — bounded fallback used)"}`,
      `- **Summary:** ${contributor.summary}`,
      `- **Open questions:** ${contributor.open_questions.length ? contributor.open_questions.join(" | ") : "(none)"}`,
      `- **Errors:** ${contributor.errors.length ? contributor.errors.map((error) => `${error.code}: ${error.message}`).join(" | ") : "(none)"}`,
      "",
    ]),
  ];
}

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
