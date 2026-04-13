import { Inject, Injectable } from "@nestjs/common";
import { RunStore } from "../execution/run-store.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord } from "../graph/types.js";
import type { ExecutionRunRecord } from "../execution/types.js";
import type {
  ReconciliationDriftPattern,
  ReconciliationOverlap,
  ReconciliationReport,
  ReconciliationRunReference,
} from "./types.js";

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(RunStore) private readonly runStore: RunStore,
  ) {}

  listReports(workItemId?: string): ReconciliationReport[] {
    const workItems = workItemId
      ? [this.workItemsService.get(workItemId)]
      : this.workItemsService.list().filter((item) => item.actual_files.length > 0 || item.predicted_files.length > 0);

    const allWorkItems = this.workItemsService.list();
    const completedRuns = this.runStore.listRecentRuns().filter((run) => run.status === "completed");

    return workItems
      .map((workItem) => this.buildReport(workItem, allWorkItems, completedRuns))
      .sort((a, b) => {
        const aTime = a.latest_run?.completed_at ?? "";
        const bTime = b.latest_run?.completed_at ?? "";
        return bTime.localeCompare(aTime) || a.work_item_id.localeCompare(b.work_item_id);
      });
  }

  getReport(workItemId: string): ReconciliationReport {
    return this.listReports(workItemId)[0];
  }

  private buildReport(
    workItem: WorkItemRecord,
    allWorkItems: WorkItemRecord[],
    completedRuns: ExecutionRunRecord[],
  ): ReconciliationReport {
    const predictedFiles = this.uniqueSorted(workItem.predicted_files);
    const actualFiles = this.uniqueSorted(workItem.actual_files);
    const matched = predictedFiles.filter((file) => actualFiles.includes(file));
    const missed = predictedFiles.filter((file) => !actualFiles.includes(file));
    const unpredicted = actualFiles.filter((file) => !predictedFiles.includes(file));
    const overlapCandidates = this.computeOverlapCandidates(workItem, allWorkItems, actualFiles);
    const recentRuns = completedRuns
      .filter((run) => run.work_item_id === workItem.id)
      .map((run) => this.toRunReference(run));
    const latestRun = recentRuns[0] ?? null;
    const driftPatterns = this.computeDriftPatterns(predictedFiles, actualFiles, matched, missed, unpredicted, overlapCandidates);

    return {
      work_item_id: workItem.id,
      work_item_name: workItem.name,
      repo: workItem.repo,
      issue_url: workItem.issue_url,
      predicted_files: predictedFiles,
      actual_files: actualFiles,
      comparison: {
        matched_files: matched,
        missed_predicted_files: missed,
        unpredicted_actual_files: unpredicted,
      },
      overlap_candidates: overlapCandidates,
      drift_patterns: driftPatterns,
      latest_run: latestRun,
      recent_runs: recentRuns,
      stats: {
        predicted_count: predictedFiles.length,
        actual_count: actualFiles.length,
        matched_count: matched.length,
        missed_count: missed.length,
        unpredicted_count: unpredicted.length,
        overlap_count: overlapCandidates.length,
      },
    };
  }

  private computeOverlapCandidates(
    workItem: WorkItemRecord,
    allWorkItems: WorkItemRecord[],
    actualFiles: string[],
  ): ReconciliationOverlap[] {
    return actualFiles
      .map((file) => {
        const overlappingWorkItemIds = allWorkItems
          .filter((candidate) => candidate.id !== workItem.id)
          .filter((candidate) => candidate.predicted_files.includes(file))
          .map((candidate) => candidate.id)
          .sort();

        return {
          file,
          overlapping_work_item_ids: overlappingWorkItemIds,
        } satisfies ReconciliationOverlap;
      })
      .filter((item) => item.overlapping_work_item_ids.length > 0);
  }

  private computeDriftPatterns(
    predictedFiles: string[],
    actualFiles: string[],
    matched: string[],
    missed: string[],
    unpredicted: string[],
    overlapCandidates: ReconciliationOverlap[],
  ): ReconciliationDriftPattern[] {
    const patterns: ReconciliationDriftPattern[] = [];

    if (predictedFiles.length === 0 && actualFiles.length > 0) {
      patterns.push({
        kind: "no_prediction",
        summary: `Execution changed ${actualFiles.length} file(s) without any predicted file scope recorded on the work item.`,
      });
    }

    if (predictedFiles.length > 0 && actualFiles.length === 0) {
      patterns.push({
        kind: "no_actual_changes",
        summary: `The work item predicted ${predictedFiles.length} file(s), but no actual changed files were recorded yet.`,
      });
    }

    if (missed.length === 0 && unpredicted.length === 0 && predictedFiles.length > 0 && actualFiles.length > 0) {
      patterns.push({
        kind: "exact_match",
        summary: `Predicted and actual file scope matched exactly across ${matched.length} file(s).`,
      });
    }

    if (missed.length > 0 && unpredicted.length === 0) {
      patterns.push({
        kind: "overprediction",
        summary: `${missed.length} predicted file(s) were not actually touched. Planning may be overestimating implementation scope.`,
      });
    }

    if (unpredicted.length > 0 && missed.length === 0) {
      patterns.push({
        kind: "unpredicted_change",
        summary: `${unpredicted.length} changed file(s) were outside the predicted scope. Planning may be missing downstream impact.`,
      });
    }

    if (unpredicted.length > 0 && missed.length > 0) {
      patterns.push({
        kind: "mixed_drift",
        summary: `Prediction drift was mixed: ${missed.length} predicted file(s) were untouched and ${unpredicted.length} actual file(s) were unpredicted.`,
      });
    }

    if (overlapCandidates.length > 0) {
      patterns.push({
        kind: "mixed_drift",
        summary: `${overlapCandidates.length} changed file(s) also appear in other work items' predicted scope, suggesting overlap risk.`,
      });
    }

    return patterns;
  }

  private toRunReference(run: ExecutionRunRecord): ReconciliationRunReference {
    return {
      run_id: run.run_id,
      status: run.status,
      completed_at: run.completed_at,
      artifact_dir: run.artifact_dir,
      changed_files: run.changed_files ?? [],
    };
  }

  private uniqueSorted(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))].sort();
  }
}
