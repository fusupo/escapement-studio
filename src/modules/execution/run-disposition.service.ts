import { BadRequestException, Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { archiveDir, archivesRoot, planDir } from "../../lib/context-layout.js";
import { GitHubService } from "../github/github.service.js";
import type {
  HsmActionHandlerContext,
  WorkItemHsmEvent,
  WorkItemRecord,
} from "../graph/types.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { PlansService } from "../plans/plans.service.js";
import { ExecutionService } from "./execution.service.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";
import { RunStore } from "./run-store.service.js";
import { archiveRunArtifactsForWorkItem } from "./run-archiver.js";
import type {
  ArchiveAndCloseMergedPullRequestResult,
  ArchiveRunArtifactsResult,
  CancelWorkItemDto,
  CancelWorkItemResult,
  ClosedGitHubIssueSummary,
  CloseMergedPullRequestResult,
  DeleteWorkItemDto,
  DeleteWorkItemResult,
  ExecutionRunRecord,
  StudioArchiveMeta,
} from "./types.js";

/**
 * Phase 3 of the cqrs refactor (#223): owns the "given a work item,
 * put it into a terminal state and tidy up the filesystem + GitHub +
 * run buffer" responsibility. Extracted verbatim from `ExecutionService`
 * to break the ~800-line disposition cluster out of the god class.
 *
 * Methods:
 *   - closeMergedPullRequest / archiveAndCloseMergedPullRequest
 *     — merged_pr → done/archived orchestration
 *   - cancelWorkItem / deleteWorkItem — pre-PR cancellation + delete
 *   - archiveRunArtifacts — standalone archival helper
 *   - archiveRunArtifactsAction — HSM action adapter for runArchiver
 *   - captureRunSnapshotForWorkItem / movePlanDirToArchives (private)
 *   - removeRunsForWorkItem (private finalizer)
 *   - disposition guards: assertCancelEligible / assertDeleteEligible /
 *     assertWorkItemInMergedPr / assertNoActiveRunForWorkItem / leafState
 *
 * Temporary deps on `ExecutionService`:
 *   - `listRecentRuns()` — read the in-memory run buffer
 *   - `disposeRunsForWorkItemInBuffer()` — splice buffer entries and
 *     stamp disposed_at (added in the previous commit)
 *   - `emitRunExecutionResult()` — emit SSE events for disposed runs
 *   - `getPreview()` — build the dispatch-preview envelope
 *
 * Phase 4 extracts a `RunStore` sub-service that absorbs these four
 * methods; at that point the forwardRef ExecutionService injection
 * on this class becomes a one-way RunStore injection and the
 * Graph ↔ Execution cycle is gone.
 */
@Injectable()
export class RunDispositionService {
  private readonly logger = new Logger(RunDispositionService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);

  constructor(
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
    @Inject(GitHubBatchCache) private readonly githubBatchCache: GitHubBatchCache,
    @Inject(forwardRef(() => PlansService)) private readonly plansService: PlansService,
    // Phase 4a (#230): forwardRef(ExecutionService) survives ONLY for
    // `getPreview` used in the close/archive response envelopes. The
    // buffer/stream/seam half of the Phase 3 dependency is now served
    // by RunStore (injected below). Phase 9a (#240) will audit whether
    // this residual can be unwrapped.
    @Inject(forwardRef(() => ExecutionService)) private readonly executionService: ExecutionService,
    @Inject(RunStore) private readonly runStore: RunStore,
  ) {}

  async closeMergedPullRequest(workItemId: string): Promise<CloseMergedPullRequestResult> {
    // Pre-dispatch guard: refuse while a run is live (HSM doesn't know about runs).
    this.assertNoActiveRunForWorkItem(workItemId);

    const result = await this.hsmService.dispatch(workItemId, { type: "user.finalize" });

    if (result.rejected) {
      throw new BadRequestException(
        `cannot_dispose: HSM rejected user.finalize from state ${result.prev_state}`,
      );
    }

    // studio-197: write-through closed issue to batch cache.
    const closedIssue = (result.handler_data?.closed_issue as ClosedGitHubIssueSummary) ?? null;
    if (closedIssue) {
      const wi = this.workItemsService.get(workItemId);
      if (wi.repo) {
        this.githubBatchCache.upsertIssue(wi.repo, {
          number: closedIssue.number,
          state: "closed",
          closed_at: new Date().toISOString(),
          url: closedIssue.url,
          title: closedIssue.title,
        });
      }
    }

    // Post-dispatch finalizer: dispose matching runs.
    const removedRunIds = this.runStore.disposeRunsForWorkItem(workItemId, () => this.now());

    // Build the response envelope.
    const updatedWorkItem = this.workItemsService.get(workItemId);

    return {
      work_item: {
        id: updatedWorkItem.id,
        state: updatedWorkItem.state,
        branch: updatedWorkItem.branch,
        archive_path: updatedWorkItem.archive_path,
        actual_files: updatedWorkItem.actual_files,
        meta: updatedWorkItem.meta,
        updated_at: updatedWorkItem.updated_at,
      },
      closed_issue: closedIssue,
      removed_run_ids: removedRunIds,
      dispatch_preview: this.executionService.getPreview(updatedWorkItem.repo ?? undefined),
    };
  }

  async archiveAndCloseMergedPullRequest(
    workItemId: string,
  ): Promise<ArchiveAndCloseMergedPullRequestResult> {
    // Pre-dispatch guard.
    this.assertNoActiveRunForWorkItem(workItemId);

    const result = await this.hsmService.dispatch(workItemId, {
      type: "user.archive_and_finalize",
    });

    if (result.rejected) {
      throw new BadRequestException(
        `cannot_dispose: HSM rejected user.archive_and_finalize from state ${result.prev_state}`,
      );
    }

    // studio-197: write-through closed issue to batch cache.
    const closedIssue = (result.handler_data?.closed_issue as ClosedGitHubIssueSummary) ?? null;
    if (closedIssue) {
      const wi = this.workItemsService.get(workItemId);
      if (wi.repo) {
        this.githubBatchCache.upsertIssue(wi.repo, {
          number: closedIssue.number,
          state: "closed",
          closed_at: new Date().toISOString(),
          url: closedIssue.url,
          title: closedIssue.title,
        });
      }
    }

    // Post-dispatch finalizer.
    const removedRunIds = this.runStore.disposeRunsForWorkItem(workItemId, () => this.now());

    const updatedWorkItem = this.workItemsService.get(workItemId);
    const archiveData = result.handler_data?.archive_result as {
      archive_path: string;
      readme_path: string | null;
      archived_run_ids: string[];
      skipped_run_ids: Array<{ run_id: string; reason: string }>;
    } | undefined;

    return {
      work_item: {
        id: updatedWorkItem.id,
        state: updatedWorkItem.state,
        branch: updatedWorkItem.branch,
        archive_path: updatedWorkItem.archive_path,
        actual_files: updatedWorkItem.actual_files,
        meta: updatedWorkItem.meta,
        updated_at: updatedWorkItem.updated_at,
      },
      closed_issue: closedIssue,
      removed_run_ids: removedRunIds,
      archive: archiveData ?? {
        archive_path: updatedWorkItem.archive_path ?? "",
        readme_path: null,
        archived_run_ids: [],
        skipped_run_ids: [],
      },
      dispatch_preview: this.executionService.getPreview(updatedWorkItem.repo ?? undefined),
    };
  }

  async cancelWorkItem(input: CancelWorkItemDto): Promise<CancelWorkItemResult> {
    const workItemId = input.work_item_id?.trim();
    if (!workItemId) {
      throw new BadRequestException("work_item_id is required");
    }
    if (input.confirm_cancel !== true) {
      throw new BadRequestException("confirm_cancel must be true");
    }

    const workItem = this.workItemsService.get(workItemId);
    this.assertCancelEligible(workItem);
    this.assertNoActiveRunForWorkItem(workItemId);

    const closedIssue = await this.githubService.closeIssue(
      workItem.repo ?? "",
      Number(workItem.issue_number),
      input.cancel_note,
    );

    const moveResult = this.movePlanDirToArchives(workItemId);
    const result = await this.hsmService.dispatch(workItemId, { type: "user.cancel" });
    if (result.rejected) {
      throw new BadRequestException(
        `cancel_work_item_transition_failed_after_github_close: HSM rejected user.cancel from state ${result.prev_state}`,
      );
    }

    const nextArchivePath = moveResult.archive_path ?? this.workItemsService.get(workItemId).archive_path;
    if (nextArchivePath) {
      this.workItemsService.update(workItemId, { archive_path: nextArchivePath });
    }

    const updatedWorkItem = this.workItemsService.get(workItemId);
    return {
      cancelled: true,
      work_item: {
        id: updatedWorkItem.id,
        state: updatedWorkItem.state,
        archive_path: updatedWorkItem.archive_path,
        updated_at: updatedWorkItem.updated_at,
      },
      closed_issue: {
        repo: closedIssue.repo,
        number: closedIssue.number,
        url: closedIssue.url,
        title: closedIssue.title,
        state: closedIssue.state,
      },
      warnings: [],
    };
  }

  async deleteWorkItem(input: DeleteWorkItemDto): Promise<DeleteWorkItemResult> {
    const workItemId = input.work_item_id?.trim();
    if (!workItemId) {
      throw new BadRequestException("work_item_id is required");
    }
    if (input.confirm_delete !== true) {
      throw new BadRequestException("confirm_delete must be true");
    }

    const workItem = this.workItemsService.get(workItemId);
    this.assertDeleteEligible(workItem);
    this.assertNoActiveRunForWorkItem(workItemId);

    const connectedEdges = this.workItemsService.getConnectedEdges(workItemId);
    if (connectedEdges.length > 0 && input.acknowledge_connected_edges !== true) {
      throw new BadRequestException(
        `delete_work_item_requires_connected_edge_acknowledgement: ${workItemId}`,
      );
    }

    const warnings: string[] = [];
    let githubIssue: DeleteWorkItemResult["github_issue"] = {
      attempted: false,
      deleted: false,
      fallback_used: false,
      message: null,
    };

    try {
      githubIssue = {
        attempted: true,
        deleted: true,
        fallback_used: false,
        message: null,
      };
      await this.githubService.deleteIssue(workItem.repo ?? "", Number(workItem.issue_number));
    } catch (error) {
      const message = this.getErrorMessage(error);
      if (input.allow_graph_delete_without_github !== true) {
        throw new BadRequestException(`github_issue_delete_failed: ${message}`);
      }
      githubIssue = {
        attempted: true,
        deleted: false,
        fallback_used: true,
        message,
      };
      warnings.push(`GitHub issue was not deleted: ${message}`);
    }

    const planCleanup = this.plansService.deletePlanArtifacts(workItemId);
    const graphResult = this.workItemsService.deleteWithConnectedEdges(workItemId, connectedEdges.map((edge) => edge.id));

    return {
      deleted: true,
      work_item: {
        id: workItem.id,
        name: workItem.name,
        state: workItem.state,
        repo: workItem.repo,
        issue_number: workItem.issue_number,
        issue_url: workItem.issue_url,
      },
      graph: graphResult,
      github_issue: githubIssue,
      plan_cleanup: planCleanup,
      warnings,
    };
  }

  archiveRunArtifacts(workItemId: string): ArchiveRunArtifactsResult {
    const normalized = workItemId?.trim();
    if (!normalized) {
      throw new BadRequestException("work_item_id is required");
    }
    const workItem = this.workItemsService.get(normalized);
    this.assertNoActiveRunForWorkItem(normalized);

    const merged = this.runStore.captureRunSnapshotForWorkItem(normalized);

    try {
      return archiveRunArtifactsForWorkItem(this.artifactRoot, workItem, {
        runs: merged,
        onWarn: (message) => this.logger.warn(message),
      });
    } catch (error) {
      const message = this.getErrorMessage(error);
      // Translate the archiver's raw Error codes into BadRequestException
      // so the HTTP surface matches the other disposition guards.
      if (/^archive_run_active|^archive_already_exists_run/.test(message)) {
        throw new BadRequestException(message);
      }
      throw error;
    }
  }

  /**
   * HSM action adapter called by `HsmActionHandlers.runArchiver` during
   * the `archive_and_close_merged` / `archive_and_close_closed` transitions.
   *
   * Orchestrates capture + plan-dir move + run-artifact archival and
   * mutates the HSM context with the results. Mirrors what the Phase 1
   * HsmActionHandlers.runArchiver did internally, but now lives on the
   * owning sub-service so the handler can be a one-liner.
   */
  async archiveRunArtifactsAction(
    workItem: WorkItemRecord,
    _event: WorkItemHsmEvent,
    ctx: HsmActionHandlerContext,
  ): Promise<void> {
    const runSnapshot = this.runStore.captureRunSnapshotForWorkItem(workItem.id);
    const moveResult = this.movePlanDirToArchives(workItem.id);

    let archiveResult: ArchiveRunArtifactsResult;
    try {
      archiveResult = archiveRunArtifactsForWorkItem(this.artifactRoot, workItem, {
        runs: runSnapshot,
        onWarn: (message) => this.logger.warn(message),
      });
    } catch (error) {
      const message = this.getErrorMessage(error);
      if (/^archive_run_active|^archive_already_exists_run/.test(message)) {
        throw new BadRequestException(message);
      }
      throw error;
    }

    const archivePath =
      archiveResult.archive_path ?? moveResult.archive_path ?? workItem.archive_path;
    const studioArchive: StudioArchiveMeta = {
      archived_at: this.now(),
      readme_path: archiveResult.readme_path,
      archived_run_ids: archiveResult.archived_run_ids,
      skipped_run_ids: archiveResult.skipped_run_ids,
    };
    ctx.meta.studio_archive = studioArchive;
    ctx.patch_overrides.archive_path = archivePath;
    ctx.handler_data.archive_result = {
      archive_path: archivePath,
      readme_path: archiveResult.readme_path,
      archived_run_ids: archiveResult.archived_run_ids,
      skipped_run_ids: archiveResult.skipped_run_ids,
    };
  }

  private movePlanDirToArchives(workItemId: string): { moved: boolean; archive_path: string | null } {
    const src = planDir(this.artifactRoot, workItemId);
    const dest = archiveDir(this.artifactRoot, workItemId);

    if (!existsSync(src)) {
      this.logger.warn(
        `movePlanDirToArchives: plan dir ${src} does not exist for work item ${workItemId}; archive step is a no-op`,
      );
      return { moved: false, archive_path: null };
    }

    if (existsSync(dest)) {
      throw new BadRequestException(
        `archive_already_exists: refusing to move plan dir for ${workItemId} — destination ${dest} already exists. Resolve the collision manually before retrying.`,
      );
    }

    mkdirSync(archivesRoot(this.artifactRoot), { recursive: true });
    renameSync(src, dest);
    return { moved: true, archive_path: dest };
  }

  private leafState(state: string): string {
    return state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
  }

  private assertCancelEligible(workItem: WorkItemRecord): void {
    const leafState = this.leafState(workItem.state);
    const eligibleStates = new Set(["planned", "drafting", "ready", "in_progress", "deferred"]);

    if (workItem.kind !== "issue" || !workItem.repo || !workItem.issue_number) {
      throw new BadRequestException(`cancel_work_item_not_issue_backed: ${workItem.id}`);
    }
    if (!eligibleStates.has(leafState)) {
      throw new BadRequestException(
        `cancel_work_item_ineligible_state: ${workItem.id} is ${workItem.state}; cancel is limited to pre-PR issue-backed work items`,
      );
    }
  }

  private assertDeleteEligible(workItem: WorkItemRecord): void {
    const leafState = this.leafState(workItem.state);
    const eligibleStates = new Set(["planned", "drafting", "ready"]);

    if (workItem.kind !== "issue" || !workItem.repo || !workItem.issue_number) {
      throw new BadRequestException(`delete_work_item_not_issue_backed: ${workItem.id}`);
    }
    if (!eligibleStates.has(leafState)) {
      throw new BadRequestException(
        `delete_work_item_ineligible_state: ${workItem.id} is ${workItem.state}; destructive delete is limited to planned, drafting, or ready items`,
      );
    }
  }

  private assertWorkItemInMergedPr(workItemId: string): WorkItemRecord {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "merged_pr") {
      throw new BadRequestException(
        `work_item_not_in_merged_pr: cannot dispose ${workItemId} (state is ${workItem.state}, requires merged_pr)`,
      );
    }
    return workItem;
  }

  private assertNoActiveRunForWorkItem(workItemId: string): void {
    const activeStatuses = ["queued", "preparing", "disambiguating", "running"] as const;
    const activeRun = this.runStore.listRecentRuns().find(
      (run) =>
        run.work_item_id === workItemId &&
        (activeStatuses as readonly string[]).includes(run.status),
    );
    if (activeRun) {
      throw new BadRequestException(
        `cannot_dispose_work_item_active_run: run ${activeRun.run_id} is ${activeRun.status} for work item ${workItemId}. ` +
          `Wait for the run to finish or clean it up first.`,
      );
    }
  }

  // Duplicated trivial helpers — see SCRATCHPAD_223 §"Helpers" decision.
  // Phase 9 can extract these to a shared util if it wants.

  private now(): string {
    return new Date().toISOString();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isMissingFileError(error: unknown): boolean {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT";
  }
}
