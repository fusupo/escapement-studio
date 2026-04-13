import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { createAgentSession, createCodingTools, SessionManager, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import {
  readPlanMetadata,
  runDir,
  workItemSlug,
  writePlanMetadata,
} from "../../lib/context-layout.js";
import { fetchIssueBody } from "../../lib/github-cli.js";
import { getDefaultWorkingBranch, listDefaultWorkingBranches } from "./default-working-branches.js";
import { listArchivedRunBundles, readArchivedRunBundle } from "./archive-reader.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService } from "./scratchpad.service.js";
import { WorkItemReconcilerService } from "./work-item-reconciler.service.js";
import { WorktreeService } from "./worktree.service.js";
import { GitHubService } from "../github/github.service.js";
import { GraphService } from "../graph/graph.service.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { SettingsService } from "../settings/settings.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import type {
  ActivityLogEntry,
  ActivityLogEntryKind,
  ArchivedRunBundle,
  CreateExecutionPullRequestDto,
  CreateExecutionPullRequestResult,
  ExecutionChecklistSnapshot,
  ExecutionDispatchGroupPreview,
  ExecutionDispatchNodePreview,
  ExecutionDispatchPreview,
  ExecutionLaunchEligibility,
  ExecutionPullRequestRecord,
  ExecutionRunRecord,
  ExecutionSafetyCheck,
  FollowUpMessageDto,
  FollowUpMessageResult,
  LaunchExecutionRunDto,
  LaunchExecutionRunResult,
  CleanupWorktreeDto,
  CleanupWorktreeResult,
  ResolveDisambiguationDto,
  ResolveDisambiguationResult,
  RunChatHistory,
  RunChatMessage,
  SyncMergedExecutionDto,
  SyncMergedExecutionResult,
} from "./types.js";

@Injectable()
export class ExecutionService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  /** Active agent sessions keyed by run_id — kept alive while run is active */
  private readonly activeSessions = new Map<string, import("@mariozechner/pi-coding-agent").AgentSession>();
  // Chat history derived from activity_log (agent_message + user_message entries)
  /** Disambiguation gate resolvers — calling the stored function unblocks the coding phase */
  private readonly disambiguationGates = new Map<string, { resolve: (additionalContext?: string) => void }>();

  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
    @Inject(GitHubBatchCache) private readonly githubBatchCache: GitHubBatchCache,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
    @Inject(WorkItemReconcilerService) private readonly workItemReconciler: WorkItemReconcilerService,
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(ScratchpadService) private readonly scratchpadService: ScratchpadService,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
  ) {
    this.githubService.registerPullRequestTruthRefresher((pullRequest, options) => this.refreshPullRequestTruth(pullRequest, options));
  }

  /**
   * Issue #176: at startup, rewrite any runs left in a non-terminal
   * status to `error` (orphaned by server restart), rehydrate
   * `recentRuns` from disk so completed runs survive a restart, and
   * run an initial reconcile pass to populate the derived view.
   *
   * This is a read-only-ish pass: the only disk mutation is the orphan
   * rewrite, which happens before the in-memory buffer is populated.
   * Any IO errors are logged and swallowed so a broken status file can
   * never prevent the server from booting.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.workItemReconciler.runStartupReconcile();
    } catch (error) {
      this.logger.warn(
        `Startup reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      this.runStore.hydrateRecentRunsFromDisk();
    } catch (error) {
      this.logger.warn(
        `Failed to hydrate recentRuns from disk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  refreshPullRequestTruth(
    pullRequest: {
      number: number;
      url: string;
      title: string;
      body: string;
      state: string;
      is_draft: boolean;
      base_ref: string;
      head_ref: string;
      merged_at: string | null;
      merge_commit_sha: string | null;
    },
    options: { work_item_ids?: string[] } = {},
  ): { updated_run_ids: string[] } {
    const updatedRunIds: string[] = [];
    const workItemIds = new Set(options.work_item_ids ?? []);

    for (const run of this.runStore.listRecentRuns()) {
      const matchesByNumber = run.pull_request?.number === pullRequest.number;
      const matchesByBranch = run.branch === pullRequest.head_ref;
      const matchesByWorkItem = workItemIds.has(run.work_item_id);
      if (!matchesByNumber && !matchesByBranch && !matchesByWorkItem) {
        continue;
      }

      const nextPullRequest: ExecutionPullRequestRecord = {
        ...(run.pull_request ?? {}),
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        body: pullRequest.body,
        base_ref: pullRequest.base_ref,
        head_ref: pullRequest.head_ref,
        is_draft: pullRequest.is_draft,
        created_at: run.pull_request?.created_at ?? this.now(),
        state: pullRequest.state,
        merged_at: pullRequest.merged_at,
        merge_commit_sha: pullRequest.merge_commit_sha,
      };

      if (this.samePullRequestRecord(run.pull_request, nextPullRequest)) {
        continue;
      }

      const nextRun = this.runStore.updateRun(run.run_id, { pull_request: nextPullRequest });
      if (!nextRun) {
        continue;
      }

      this.runStore.appendEvent(nextRun, {
        type: "pull_request_truth_refreshed",
        pull_request: {
          number: nextPullRequest.number,
          state: nextPullRequest.state,
          merged_at: nextPullRequest.merged_at,
          merge_commit_sha: nextPullRequest.merge_commit_sha,
        },
      });
      this.runStore.writeSummary(nextRun);
      updatedRunIds.push(nextRun.run_id);
    }

    return { updated_run_ids: updatedRunIds };
  }

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
      }),
    }));

    return {
      generated_at: plan.generated_at,
      assumptions: [
        ...plan.assumptions,
        `Default working branches: ${JSON.stringify(listDefaultWorkingBranches())}. Fallback: ${getDefaultWorkingBranch(null)}.`,
      ],
      validation_policy: plan.validation_policy,
      summary: plan.summary,
      groups,
      blocked: plan.sequential,
    };
  }

  getLaunchEligibility(workItemId?: string, baseRef?: string): ExecutionLaunchEligibility {
    const normalizedWorkItemId = workItemId?.trim();
    if (!normalizedWorkItemId) {
      throw new BadRequestException("work_item_id is required");
    }

    const workItem = this.workItemsService.get(normalizedWorkItemId);
    const normalizedBaseRef = baseRef?.trim() || getDefaultWorkingBranch(workItem.repo);
    return this.resolveLaunchEligibility(workItem, { baseRef: normalizedBaseRef });
  }

  async launch(input: LaunchExecutionRunDto): Promise<LaunchExecutionRunResult> {
    const workItemId = input.work_item_id?.trim();
    if (!workItemId) {
      throw new BadRequestException("work_item_id is required");
    }

    const workItem = this.workItemsService.get(workItemId);
    const baseRef = input.base_ref?.trim() || getDefaultWorkingBranch(workItem.repo);
    const eligibility = this.resolveLaunchEligibility(workItem, { baseRef });
    const node = eligibility.dispatch_node;

    if (!eligibility.can_launch || !node) {
      const branch = node?.branch ?? workItem.branch ?? `${workItem.id}-branch`;
      const worktreePath = node?.worktree_path ?? this.worktreeService.getWorktreePath(branch);
      const blockedReason = eligibility.launch_unavailable_reason ?? "Work item is not currently launchable.";
      const blockedCode = eligibility.launch_unavailable_code ?? "launch_unavailable";
      const run = this.createRunRecord({
        workItem,
        branch,
        baseRef,
        worktreePath,
        safetyChecks: eligibility.safety_checks,
        prompt: input.prompt?.trim() || (node ? this.buildPrompt(workItem, node) : ""),
        status: "blocked",
        resultSummary: `Launch blocked: ${blockedReason}`,
        errors: eligibility.safety_checks.filter((check) => check.status === "fail").map((check) => ({ code: check.code, message: check.message })),
      });
      if (run.errors == null || run.errors.length === 0) {
        run.errors = [{ code: blockedCode, message: blockedReason }];
      }
      this.runStore.persistRun(run);
      this.runStore.emitRun("execution_result", run);
      return { accepted: false, run };
    }

    const launchState = await this.markWorkItemInProgressOnLaunch(workItem);
    const run = this.createRunRecord({
      workItem: launchState.workItem,
      branch: node.branch,
      baseRef,
      worktreePath: node.worktree_path,
      safetyChecks: eligibility.safety_checks,
      prompt: input.prompt?.trim() || this.buildPrompt(launchState.workItem, node),
      status: "queued",
      resultSummary: undefined,
      errors: [],
    });

    this.runStore.persistRun(run);
    // ADR 014 step 5: record the run ID on the plan so the plan metadata
    // knows about every attempt (including blocked/failed ones). Non-fatal.
    this.appendRunIdToPlanMetadata(run.work_item_id, run.run_id);
    this.pushActivity(
      run.run_id,
      "status_change",
      launchState.transitioned
        ? "Execution run queued. Work item state updated to in_progress."
        : "Execution run queued.",
    );
    void this.executeRun(run, node, input.disambiguate !== false).catch((error) => {
      this.pushActivity(run.run_id, "error", `Execution failed: ${this.getErrorMessage(error)}`);
      const failedRun = this.runStore.updateRun(run.run_id, {
        status: "error",
        completed_at: this.now(),
        progress_message: `Execution failed: ${this.getErrorMessage(error)}`,
        result_summary: `Execution failed: ${this.getErrorMessage(error)}`,
        errors: [{ code: "execution_failed", message: this.getErrorMessage(error) }],
      });
      if (failedRun) {
        this.runStore.writeSummary(failedRun);
        this.runStore.appendEvent(failedRun, { type: "run_failed", error: this.getErrorMessage(error) });
        this.runStore.emitRun("execution_result", failedRun);
      }
    });

    return { accepted: true, run };
  }

  async createPullRequest(input: CreateExecutionPullRequestDto): Promise<CreateExecutionPullRequestResult> {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new BadRequestException(`Unknown execution run: ${runId}`);
    }
    if (run.status !== "completed") {
      throw new BadRequestException(`Execution run ${runId} must be completed before creating a pull request`);
    }
    if (run.pull_request) {
      return { run, pull_request: run.pull_request };
    }

    const workItem = this.workItemsService.get(run.work_item_id);
    const baseRef = input.base_ref?.trim() || run.base_ref || getDefaultWorkingBranch(workItem.repo);

    // Auto-stage and commit if requested and worktree has uncommitted changes
    if (input.auto_commit !== false) {
      this.autoStageAndCommit(run, workItem, input.commit_message);
    }

    // ADR 014 step 6: hard guards at PR creation. These run even when
    // auto_commit: false (the auto-commit guard is inside an optional
    // branch) and they cover both the current staged state and the
    // branch's full committed history relative to the base ref.
    const prStagedViolations = this.scratchpadService.findStagedScratchpadViolations(run.worktree_path);
    if (prStagedViolations.length > 0) {
      this.runStore.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request",
        paths: prStagedViolations,
      });
      throw new BadRequestException(
        `pull_request_blocked_by_scratchpad: the following scratchpad files are staged and must not be committed before opening a pull request: ${prStagedViolations.join(", ")}. ` +
          `Unstage them (git reset HEAD -- <path>) before retrying.`,
      );
    }

    const committedViolations = this.scratchpadService.findCommittedScratchpadViolations(run.worktree_path, baseRef);
    if (committedViolations.length > 0) {
      this.runStore.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request_history",
        paths: committedViolations,
      });
      throw new BadRequestException(
        `pull_request_blocked_by_committed_scratchpad: the following scratchpad files were committed to branch ${run.branch}: ${committedViolations.join(", ")}. ` +
          `Inspect the history with \`git log ${baseRef}...HEAD -- '${committedViolations[0]}'\` and remove the files from the branch (e.g. \`git rm\` + rewrite) before opening a pull request.`,
      );
    }

    const title = input.title?.trim() || this.buildPullRequestTitle(workItem);
    const body = input.body?.trim() || this.buildPullRequestBody(run, workItem, baseRef);
    const aheadCount = this.worktreeService.countCommitsAhead(run.worktree_path, baseRef, run.branch);
    if (aheadCount === 0) {
      throw new BadRequestException(`Branch ${run.branch} has no commits ahead of ${baseRef}; nothing is ready to open as a pull request`);
    }

    this.worktreeService.runGitIn(run.worktree_path, ["push", "--set-upstream", "origin", run.branch]);
    this.worktreeService.runGhIn(run.worktree_path, [
      "pr",
      "create",
      "--base",
      baseRef,
      "--head",
      run.branch,
      "--title",
      title,
      "--body-file",
      "-",
      ...(input.draft ? ["--draft"] : []),
    ], body);

    const pullRequest = this.readPullRequest(run.worktree_path, title, body);
    const nextRun = this.runStore.updateRun(run.run_id, { pull_request: pullRequest }) ?? run;
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "pull-request.json"), JSON.stringify(pullRequest, null, 2), "utf8");
    this.runStore.appendEvent(nextRun, { type: "pull_request_created", pull_request: pullRequest });
    this.runStore.writeSummary(nextRun);

    // Update work item: dispatch HSM event for state transition, then
    // write non-state fields (branch, meta.pull_request) separately.
    try {
      const prPayload = {
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        is_draft: pullRequest.is_draft,
        head_ref: pullRequest.head_ref,
        base_ref: pullRequest.base_ref,
        created_at: pullRequest.created_at,
      };
      await this.hsmService.dispatch(run.work_item_id, {
        type: "gh.pr_opened",
        pull_request: prPayload,
      });
      // studio-197: write-through to batch cache so next reconcile sees the PR.
      if (workItem.repo) {
        this.githubBatchCache.upsertPullRequest(workItem.repo, {
          number: pullRequest.number,
          state: "OPEN",
          merged_at: null,
          head_ref: pullRequest.head_ref,
          base_ref: pullRequest.base_ref,
          url: pullRequest.url,
          title: pullRequest.title,
          is_draft: pullRequest.is_draft ?? false,
        });
      }
      // Write additional meta fields that the HSM doesn't manage.
      // Branch is now set by the HSM's stampMeta:studio_open_pr_sync action.
      const existingMeta = this.workItemsService.get(run.work_item_id).meta ?? {};
      this.workItemsService.update(run.work_item_id, {
        meta: {
          ...existingMeta,
          pull_request: prPayload,
        },
      });
    } catch (updateError) {
      this.logger.warn(`Failed to update work item ${run.work_item_id} after PR creation: ${this.getErrorMessage(updateError)}`);
    }

    return { run: nextRun, pull_request: pullRequest };
  }

  async syncMergedPullRequest(input: SyncMergedExecutionDto): Promise<SyncMergedExecutionResult> {
    const workItemId = input.work_item_id?.trim();
    if (!workItemId) {
      throw new BadRequestException("work_item_id is required");
    }

    const workItem = this.workItemsService.get(workItemId);
    if (!workItem.repo) {
      throw new BadRequestException(`Work item ${workItemId} is missing repo metadata required for PR sync`);
    }

    const pullRequest = input.pull_request_number
      ? await this.githubService.readPullRequest(workItem.repo, input.pull_request_number)
      : await this.resolvePullRequestFromWorkItem(workItem);

    if (!pullRequest.merged_at) {
      throw new BadRequestException(`Pull request #${pullRequest.number} has not been merged yet`);
    }

    const matchedRun = this.findRecentRunForSync(workItem, pullRequest.number);
    const actualFilesSelection = this.selectActualFilesForMergeSync(input, workItem, matchedRun);
    const nextBranch = this.normalizeNullableString(input.branch) ?? workItem.branch ?? (pullRequest.head_ref || null);
    const nextArchivePath = this.hasOwn(input, "archive_path") ? (input.archive_path ?? null) : workItem.archive_path;
    const nextMeta = this.buildMergedWorkItemMeta(workItem, pullRequest, matchedRun?.run_id ?? null, actualFilesSelection.source);

    // ADR 014 step 3: post-merge sync lands on 'merged_pr', not 'done'.
    // 'merged_pr' is a stable resting state that the disposition flow
    // (ADR 014 step 7) will transition to 'done' after archival completes.
    // HSM handles the state transition; non-state fields follow separately.
    await this.hsmService.dispatch(workItem.id, {
      type: "gh.pr_merged",
      pull_request: {
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        head_ref: pullRequest.head_ref,
        base_ref: pullRequest.base_ref,
        merged_at: pullRequest.merged_at,
      },
    });
    // studio-197: write-through to batch cache so next reconcile sees MERGED.
    this.githubBatchCache.upsertPullRequest(workItem.repo, {
      number: pullRequest.number,
      state: "MERGED",
      merged_at: pullRequest.merged_at,
      head_ref: pullRequest.head_ref,
      base_ref: pullRequest.base_ref,
      url: pullRequest.url,
      title: pullRequest.title,
      is_draft: false,
    });
    this.workItemsService.update(workItem.id, {
      actual_files: actualFilesSelection.files,
      branch: nextBranch,
      archive_path: nextArchivePath,
      meta: nextMeta,
    });

    const updatedWorkItem = this.workItemsService.get(workItem.id);
    const managedBlockSync = input.stage_github_sync ? await this.safeStageManagedBlockSync(updatedWorkItem.id) : undefined;

    if (matchedRun) {
      const nextPullRequest: ExecutionPullRequestRecord = {
        ...(matchedRun.pull_request ?? this.toExecutionPullRequestRecord(pullRequest)),
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        body: pullRequest.body,
        base_ref: pullRequest.base_ref,
        head_ref: pullRequest.head_ref,
        is_draft: pullRequest.is_draft,
        state: pullRequest.state,
        merged_at: pullRequest.merged_at,
        merge_commit_sha: pullRequest.merge_commit_sha,
      };
      const syncedRun = this.runStore.updateRun(matchedRun.run_id, { pull_request: nextPullRequest }) ?? matchedRun;
      this.runStore.appendEvent(syncedRun, {
        type: "post_merge_sync_completed",
        work_item_id: updatedWorkItem.id,
        pull_request: nextPullRequest,
        actual_files: actualFilesSelection.files,
      });
      this.runStore.writeSummary(syncedRun);
    }

    return {
      synced: true,
      work_item: {
        id: updatedWorkItem.id,
        state: updatedWorkItem.state,
        branch: updatedWorkItem.branch,
        archive_path: updatedWorkItem.archive_path,
        actual_files: updatedWorkItem.actual_files,
        meta: updatedWorkItem.meta,
        updated_at: updatedWorkItem.updated_at,
      },
      pull_request: this.toExecutionPullRequestRecord(pullRequest),
      matched_run_id: matchedRun?.run_id ?? null,
      actual_files_source: actualFilesSelection.source,
      dispatch_preview: this.getPreview(updatedWorkItem.repo ?? undefined),
      managed_block_sync: managedBlockSync,
      cleanup: matchedRun ? this.worktreeService.safeCleanupRun(matchedRun) : null,
    };
  }

  cleanupWorktree(input: CleanupWorktreeDto): CleanupWorktreeResult {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new BadRequestException(`No recent run found with id ${runId}`);
    }

    if (run.status === "running" || run.status === "preparing" || run.status === "disambiguating") {
      throw new BadRequestException(`Cannot cleanup worktree for run ${runId} — status is ${run.status}`);
    }

    return this.worktreeService.cleanupRun(run);
  }

  cleanupAllStale(): CleanupWorktreeResult[] {
    const results: CleanupWorktreeResult[] = [];
    for (const run of this.runStore.listRecentRuns()) {
      if (run.status !== "running" && run.status !== "preparing" && run.status !== "queued") {
        const result = this.worktreeService.safeCleanupRun(run);
        if (result) {
          results.push(result);
        }
      }
    }
    return results;
  }

  async resolveDisambiguation(input: ResolveDisambiguationDto): Promise<ResolveDisambiguationResult> {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new BadRequestException(`Unknown execution run: ${runId}`);
    }

    if (run.status !== "disambiguating") {
      return {
        resolved: false,
        run_id: runId,
        error: `Run is in "${run.status}" status; only runs in "disambiguating" status can be resolved.`,
      };
    }

    const gate = this.disambiguationGates.get(runId);
    if (!gate) {
      return {
        resolved: false,
        run_id: runId,
        error: "No active disambiguation gate found for this run.",
      };
    }

    gate.resolve(input.additional_context?.trim() || undefined);
    this.disambiguationGates.delete(runId);
    this.pushActivity(runId, "status_change", "Disambiguation resolved — proceeding to coding.");
    return { resolved: true, run_id: runId };
  }

  /** Read AGENTS.md or CLAUDE.md from a directory if it exists. */
  private readProjectContext(dir: string): string | null {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = join(dir, name);
      if (existsSync(p)) {
        try { return readFileSync(p, "utf8"); } catch { /* ignore */ }
      }
    }
    return null;
  }

  private async executeRun(initialRun: ExecutionRunRecord, node: ExecutionDispatchNodePreview, disambiguate = true) {
    let run = this.runStore.updateRun(initialRun.run_id, {
      status: "preparing",
      progress_message: "Creating isolated git worktree.",
    });
    if (!run) {
      return;
    }
    this.runStore.appendEvent(run, { type: "run_preparing" });
    this.runStore.emitRun("execution_status", run);

    // --- Create worktree ---
    this.worktreeService.createWorktree(run.branch, run.base_ref, run.worktree_path);
    this.pushActivity(run.run_id, "status_change", `Worktree created at ${run.worktree_path}`, `Branch: ${run.branch}, Base: ${run.base_ref}`);
    this.runStore.appendEvent(run, { type: "worktree_created", worktree_path: run.worktree_path, branch: run.branch, base_ref: run.base_ref });

    // --- Install dependencies in worktree ---
    // Emit a status event before the potentially slow install so the UI shows progress.
    this.runStore.emitRun("execution_status", run);
    const runIdForActivity = run.run_id;
    this.worktreeService.installDependencies(run.worktree_path, (kind, message) => {
      this.pushActivity(runIdForActivity, kind, message);
    });

    // --- Gather context ---
    const workItem = this.workItemsService.get(run.work_item_id);
    const issueBody = fetchIssueBody(workItem.repo, workItem.issue_number);
    const projectContext = this.readProjectContext(run.worktree_path);
    this.pushActivity(run.run_id, "status_change", `Context gathered: issue body ${issueBody ? "found" : "not found"}, project conventions ${projectContext ? "found" : "not found"}`);

    // --- Write initial scratchpad ---
    // ADR 014 step 5: when the plan reached `ready` via PlansService.approve,
    // the canonical scratchpad is the executable contract — copied into the
    // worktree verbatim and the setup-phase agent turn is skipped below.
    // Otherwise (fallback for `planned` items) a skeleton is synthesized.
    const scratchpadResult = this.scratchpadService.writeScratchpad(run, node);
    const scratchpadPath = scratchpadResult.path;
    const hasApprovedPlan = scratchpadResult.source === "canonical_ready";
    this.pushActivity(
      run.run_id,
      "status_change",
      hasApprovedPlan
        ? `Approved plan loaded from canonical scratchpad at ${scratchpadPath}`
        : `Scratchpad written to ${scratchpadPath}`,
    );
    this.runStore.appendEvent(run, { type: "scratchpad_written", path: scratchpadPath });
    this.scratchpadService.emitChecklistIfChanged(run);

    // --- Create agent session ---
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: run.worktree_path,
      sessionManager: SessionManager.inMemory(run.worktree_path),
      tools: createCodingTools(run.worktree_path),
      model: this.settingsService.getSelectedModel(),
    });

    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    run = this.runStore.updateRun(initialRun.run_id, {
      status: "running",
      started_at: this.now(),
      session_id: session.sessionId,
      progress_message: "Agent session started — setup phase.",
    })!;
    this.pushActivity(run.run_id, "status_change", "Agent session started.");
    this.runStore.appendEvent(run, { type: "session_started", session_id: session.sessionId });
    this.runStore.emitRun("execution_status", run);

    this.activeSessions.set(run.run_id, session);
    const runId = run.run_id;
    const unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(runId, event);
    });

    try {
      // ============================================================
      // PHASE 1: SETUP (like setup-work skill)
      // Agent reads issue, analyzes codebase, writes implementation
      // plan into the canonical scratchpad, surfaces questions.
      //
      // ADR 014 step 5: skip entirely when an approved plan was loaded
      // from canonical — the approved scratchpad IS the executable contract.
      // ============================================================
      const scratchpadName = `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md`;
      const shouldRunSetupPhase = disambiguate && !hasApprovedPlan;
      if (hasApprovedPlan) {
        this.pushActivity(
          runId,
          "status_change",
          "Approved plan loaded from canonical — skipping setup phase.",
        );
        this.runStore.appendEvent(run, { type: "setup_phase_skipped" });

        // studio-170: if the approved scratchpad still has open
        // clarifications or blockers, trigger the existing
        // disambiguation gate before entering the coding phase so the
        // user can review and resolve them. Honors the `disambiguate`
        // opt-out flag the same way `shouldRunSetupPhase` does.
        if (disambiguate) {
          let openItems: { questions: string[]; blockers: string[] } = {
            questions: [],
            blockers: [],
          };
          try {
            const scratchpadContent = readFileSync(scratchpadPath, "utf8");
            openItems = this.scratchpadService.parseScratchpadOpenItems(scratchpadContent);
          } catch (error) {
            this.logger.warn(
              `executeRun: failed to read approved scratchpad at ${scratchpadPath} ` +
                `for disambiguation parse: ${this.getErrorMessage(error)}`,
            );
          }

          const totalOpen = openItems.questions.length + openItems.blockers.length;
          if (totalOpen > 0) {
            const qLabel = `${openItems.questions.length} clarification${openItems.questions.length === 1 ? "" : "s"}`;
            const bLabel = `${openItems.blockers.length} blocker${openItems.blockers.length === 1 ? "" : "s"}`;
            const progressSummary = `${qLabel} and ${bLabel} open in approved plan — awaiting review.`;

            this.pushActivity(
              runId,
              "info",
              `Approved plan has open items (${qLabel}, ${bLabel}) — pausing for user review before coding.`,
            );
            this.runStore.appendEvent(run, { type: "setup_phase_started" });

            run = this.runStore.updateRun(runId, {
              status: "disambiguating",
              progress_message: progressSummary,
            })!;
            this.runStore.appendEvent(run, { type: "setup_phase_complete" });
            this.runStore.emitRun("execution_status", run);

            // Block until the user resolves via
            // POST /api/execution/resolve-disambiguation.
            const additionalContext = await new Promise<string | undefined>((resolve) => {
              this.disambiguationGates.set(runId, { resolve });
            });
            this.runStore.appendEvent(run, { type: "setup_approved" });

            if (additionalContext) {
              // The session has no prior orientation in the
              // approved-plan codepath, so include a minimal prompt
              // with the scratchpad filename and work item id.
              await session.prompt(
                `The approved plan for ${run.work_item_id} (${run.work_item_name}) had open items that the user just resolved with this additional context:\n\n${additionalContext}\n\nRead ${scratchpadName} in the current worktree, update the "### Clarifications Needed" and "## Blockers" sections to reflect the resolution, and make any other edits implied by the user's feedback. Then confirm you're ready to start coding.`,
              );
              this.scratchpadService.syncScratchpadToCanonical(run);
              this.scratchpadService.emitChecklistIfChanged(run);
            }

            run = this.runStore.updateRun(runId, {
              status: "running",
              progress_message: "Plan approved — coding phase started.",
            })!;
            this.pushActivity(runId, "status_change", "Plan approved. Coding phase started.");
            this.runStore.emitRun("execution_status", run);
          }
        }
      }
      if (shouldRunSetupPhase) {
        run = this.runStore.updateRun(runId, {
          status: "running",
          progress_message: "Setup phase — agent is analyzing the issue and planning implementation.",
        })!;
        this.pushActivity(runId, "status_change", "Setup phase started — agent analyzing issue and codebase.");
        this.runStore.appendEvent(run, { type: "setup_phase_started" });
        this.runStore.emitRun("execution_status", run);

        const setupPrompt = this.buildSetupPrompt(run, node, workItem, issueBody, projectContext);
        await session.prompt(setupPrompt);

        // Sync the agent's scratchpad edits back to the canonical plan file
        // (end of setup phase, before the approval gate).
        this.scratchpadService.syncScratchpadToCanonical(run);

        // Setup prompt finished — now switch to disambiguating so the UI shows the approval gate
        this.scratchpadService.emitChecklistIfChanged(run);
        run = this.runStore.updateRun(runId, {
          status: "disambiguating",
          progress_message: "Setup complete. Review the implementation plan and approve to start coding.",
        })!;
        this.pushActivity(runId, "info", "Setup complete — implementation plan ready for review.");
        this.runStore.appendEvent(run, { type: "setup_phase_complete" });
        this.runStore.emitRun("execution_status", run);

        // Block until the user approves — gate is now ready
        const additionalContext = await new Promise<string | undefined>((resolve) => {
          this.disambiguationGates.set(runId, { resolve });
        });
        this.runStore.appendEvent(run, { type: "setup_approved" });

        if (additionalContext) {
          await session.prompt(
            `The user provided feedback on your plan:\n\n${additionalContext}\n\nUpdate the ${scratchpadName} implementation plan accordingly, then confirm you're ready to start coding.`
          );
          this.scratchpadService.syncScratchpadToCanonical(run);
          this.scratchpadService.emitChecklistIfChanged(run);
        }

        run = this.runStore.updateRun(runId, {
          status: "running",
          progress_message: "Plan approved — coding phase started.",
        })!;
        this.pushActivity(runId, "status_change", "Plan approved. Coding phase started.");
        this.runStore.emitRun("execution_status", run);
      }

      // ============================================================
      // PHASE 2: DO-WORK (like do-work skill)
      // Agent works through the scratchpad checklist task by task,
      // committing after each, updating the scratchpad as it goes
      // ============================================================
      const doWorkPrompt = this.buildDoWorkPrompt(run, node, workItem, projectContext);
      await session.prompt(doWorkPrompt);

      // Sync the agent's final scratchpad state back to canonical
      // (end of do-work phase).
      this.scratchpadService.syncScratchpadToCanonical(run);

      this.scratchpadService.emitChecklistIfChanged(run);
    } finally {
      unsubscribe();
      this.disambiguationGates.delete(run.run_id);
      this.activeSessions.delete(run.run_id);
      session.dispose();
    }

    // --- Completion ---
    const assistantText = session.getLastAssistantText()?.trim() ?? "Execution run completed.";
    const reasoningSummary = this.extractReasoningSummary(assistantText);
    if (reasoningSummary) {
      this.pushActivity(run.run_id, "reasoning", reasoningSummary);
    }
    const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "response.json"), JSON.stringify({ assistant_text: assistantText, changed_files: changedFiles, actual_files_sync: actualFilesSync }, null, 2), "utf8");

    // The canonical scratchpad at plans/<slug>/SCRATCHPAD_<slug>.md is the
    // post-run snapshot — synced above at each phase boundary. No separate
    // scratchpad-final.md is written under the run artifact dir anymore.

    this.pushActivity(run.run_id, "status_change", `Execution completed. ${changedFiles.length} file(s) changed.`);
    run = this.runStore.updateRun(initialRun.run_id, {
      status: "completed",
      completed_at: this.now(),
      progress_message: actualFilesSync.ok ? "Execution run completed. actual_files updated on the work item." : "Execution run completed.",
      result_summary: actualFilesSync.ok ? `${assistantText}\n\nactual_files synced: ${changedFiles.length} file(s).` : assistantText,
      changed_files: changedFiles,
    })!;
    this.runStore.writeSummary(run, node);
    this.runStore.appendEvent(run, { type: "run_completed", changed_files: changedFiles, actual_files_sync: actualFilesSync });
    this.runStore.emitRun("execution_result", run);
  }

  getRunActivityLog(runId: string): ActivityLogEntry[] {
    const run = this.runStore.getRun(runId);
    return run?.activity_log ?? [];
  }

  getRunChatHistory(runId: string): RunChatHistory {
    const run = this.runStore.getRun(runId);
    const messages: RunChatMessage[] = (run?.activity_log ?? [])
      .filter((e) => e.kind === "agent_message" || e.kind === "user_message")
      .map((e) => ({
        timestamp: e.timestamp,
        role: e.kind === "agent_message" ? "assistant" as const : "user" as const,
        text: e.message,
      }));
    return { run_id: runId, messages };
  }

  getRunChecklist(runId: string): ExecutionChecklistSnapshot {
    const run = this.runStore.getRun(runId);
    if (!run) {
      return { run_id: runId, items: [], completed: 0, total: 0 };
    }
    return this.scratchpadService.getRunChecklist(run);
  }

  getRunScratchpad(runId: string): { run_id: string; content: string | null } {
    const run = this.runStore.getRun(runId);
    if (!run) {
      return { run_id: runId, content: null };
    }
    return this.scratchpadService.getRunScratchpad(run);
  }

  listArchivedRunBundles(): ArchivedRunBundle[] {
    return listArchivedRunBundles(this.artifactRoot, {
      onWarn: (message) => this.logger.warn(message),
    });
  }

  getArchivedRunBundle(workItemId: string): ArchivedRunBundle {
    const normalized = workItemId?.trim();
    if (!normalized) {
      throw new BadRequestException("work_item_id is required");
    }

    // Keep the detail endpoint aligned with the rest of the execution API:
    // unknown work item ids are rejected before we look for archive files.
    this.workItemsService.get(normalized);

    const bundle = readArchivedRunBundle(this.artifactRoot, normalized, {
      onWarn: (message) => this.logger.warn(message),
    });
    if (!bundle) {
      throw new NotFoundException(`No archived run bundle found for ${normalized}`);
    }
    return bundle;
  }

  async sendFollowUp(input: FollowUpMessageDto): Promise<FollowUpMessageResult> {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }
    const message = input.message?.trim();
    if (!message) {
      throw new BadRequestException("message is required");
    }

    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new BadRequestException(`Unknown execution run: ${runId}`);
    }

    // Record the user message in the unified activity log
    this.pushActivity(runId, "user_message", message);

    const session = this.activeSessions.get(runId);

    // Active session: steer or follow-up into the live run
    if (session && (run.status === "running" || run.status === "preparing" || run.status === "disambiguating")) {
      const delivery = input.delivery ?? "followUp";
      try {
        if (delivery === "steer") {
          await session.steer(message);
        } else {
          await session.followUp(message);
        }
        this.runStore.appendEvent(run, { type: "follow_up_sent", delivery, message_length: message.length });
        return { accepted: true, run_id: runId, delivery, message };
      } catch (error) {
        const errorMessage = this.getErrorMessage(error);
        this.pushActivity(runId, "error", `Follow-up delivery failed: ${errorMessage}`);
        return { accepted: false, run_id: runId, delivery, message, error: errorMessage };
      }
    }

    // Completed run: spin up a new session in the worktree for a continuation turn
    if (run.status === "completed" && existsSync(run.worktree_path)) {
      try {
        this.pushActivity(runId, "follow_up", `Starting follow-up turn: ${message.length > 120 ? message.slice(0, 117) + "..." : message}`);
        const updatedRun = this.runStore.updateRun(runId, {
          status: "running",
          progress_message: "Follow-up turn running.",
        });
        if (!updatedRun) {
          return { accepted: false, run_id: runId, delivery: "new_turn", message, error: "Failed to update run status" };
        }

        // Fire-and-forget the follow-up turn
        void this.executeFollowUpTurn(updatedRun, message).catch((error) => {
          this.pushActivity(runId, "error", `Follow-up turn failed: ${this.getErrorMessage(error)}`);
          this.runStore.updateRun(runId, {
            status: "completed",
            progress_message: `Follow-up turn failed: ${this.getErrorMessage(error)}`,
          });
        });

        return { accepted: true, run_id: runId, delivery: "new_turn", message };
      } catch (error) {
        return { accepted: false, run_id: runId, delivery: "new_turn", message, error: this.getErrorMessage(error) };
      }
    }

    return {
      accepted: false,
      run_id: runId,
      delivery: input.delivery ?? "followUp",
      message,
      error: `Cannot send follow-up to run in status "${run.status}". Only running or completed runs accept follow-up messages.`,
    };
  }

  private async executeFollowUpTurn(run: ExecutionRunRecord, message: string) {
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: run.worktree_path,
      sessionManager: SessionManager.inMemory(run.worktree_path),
      tools: createCodingTools(run.worktree_path),
      model: this.settingsService.getSelectedModel(),
    });

    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    this.activeSessions.set(run.run_id, session);
    const unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(run.run_id, event);
    });

    try {
      await session.prompt(message);
      // ADR 014 step 5: sync the agent's scratchpad edits back to canonical
      // at follow-up turn completion (phase boundary).
      this.scratchpadService.syncScratchpadToCanonical(run);
      this.scratchpadService.emitChecklistIfChanged(run);
    } finally {
      unsubscribe();
      this.activeSessions.delete(run.run_id);
      session.dispose();
    }

    const assistantText = session.getLastAssistantText()?.trim() ?? "Follow-up turn completed without a summary.";
    this.pushActivity(run.run_id, "agent_message", assistantText);

    const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);

    this.pushActivity(run.run_id, "follow_up", `Follow-up turn completed. ${changedFiles.length} file(s) changed.`);
    const nextRun = this.runStore.updateRun(run.run_id, {
      status: "completed",
      completed_at: this.now(),
      progress_message: "Follow-up turn completed.",
      result_summary: assistantText,
      changed_files: changedFiles,
    });
    if (nextRun) {
      this.runStore.writeSummary(nextRun);
      this.runStore.appendEvent(nextRun, { type: "follow_up_turn_completed", changed_files: changedFiles, actual_files_sync: actualFilesSync });
      this.runStore.emitRun("execution_result", nextRun);
    }
  }

  // Chat messages are now stored as agent_message/user_message entries in the activity_log

  private handleSessionEvent(runId: string, event: AgentSessionEvent) {
    const run = this.runStore.getRun(runId);
    if (!run) {
      return;
    }

    const toolName = "toolName" in event ? event.toolName ?? null : null;
    if (event.type === "tool_execution_start") {
      this.runStore.appendEvent(run, { type: event.type, tool_name: toolName });
      this.pushActivity(runId, "tool_start", `Tool started: ${toolName ?? "unknown"}`);
      this.runStore.updateRun(runId, { progress_message: `${toolName ?? "tool"} running…` });
      return;
    }

    if (event.type === "tool_execution_end") {
      this.runStore.appendEvent(run, { type: event.type, tool_name: toolName });
      this.pushActivity(runId, "tool_end", `Tool finished: ${toolName ?? "unknown"}`);
      this.runStore.updateRun(runId, { progress_message: `${toolName ?? "tool"} finished.` });
      this.scratchpadService.emitChecklistIfChanged(run);
      return;
    }

    if (event.type === "message_end") {
      const message = "message" in event ? event.message : null;
      const text = this.extractTextFromMessage(message);
      this.runStore.appendEvent(run, { type: event.type, text: text?.slice(0, 2000) ?? null });
      if (text) {
        this.pushActivity(runId, "agent_message", text);
        this.runStore.emitRun("execution_status", run);
      }
      return;
    }

    if (event.type === "agent_start" || event.type === "turn_start") {
      this.runStore.appendEvent(run, { type: event.type });
      this.pushActivity(runId, "turn_start", "Execution turn started.");
      this.runStore.updateRun(runId, { progress_message: "Execution turn started." });
      return;
    }

    if (event.type === "agent_end" || event.type === "turn_end") {
      this.runStore.appendEvent(run, { type: event.type });
      this.pushActivity(runId, "turn_end", "Execution turn completed.");
      this.runStore.updateRun(runId, { progress_message: "Execution turn completed." });
    }
  }

  private pushActivity(runId: string, kind: ActivityLogEntryKind, message: string, detail?: string) {
    const timestamp = this.now();
    const entry: ActivityLogEntry = { timestamp, kind, message, ...(detail ? { detail } : {}) };
    this.runStore.appendActivityLog(runId, entry);
  }

  private resolveLaunchEligibility(
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

  private isIssueBacked(workItem: WorkItemRecord): boolean {
    return workItem.kind === "issue";
  }

  /**
   * ADR 014 step 5: gate launch on work item state.
   *
   * A work item is launchable when its state is `ready` (an approved plan
   * produced by `PlansService.approve`) or — under the transitional fallback
   * until step 4 is broadly rolled out — `planned` (inline scratchpad
   * synthesis at launch time). Every other state fails with `not_ready` so
   * the reason is visible in dispatch previews.
   *
   * TODO(ADR 014 step 5 follow-up): once every caller goes through
   * prepare→approve, drop `planned` from the launchable set and make the
   * gate strictly `ready`.
   */
  private isLaunchableState(state: WorkItemState): boolean {
    const leaf = state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
    return leaf === "ready" || leaf === "planned";
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
        "Expected 'ready' (approved plan) or 'planned' (fallback).",
    };
  }

  private buildSetupPrompt(
    run: ExecutionRunRecord,
    node: ExecutionDispatchNodePreview,
    workItem: WorkItemRecord,
    issueBody: string | null,
    projectContext: string | null,
  ): string {
    const scratchpadName = `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md`;
    const owned = node.files_owned.length ? node.files_owned.map((p) => `- ${p}`).join("\n") : "- (none predicted)";
    const shared = node.files_shared.length
      ? node.files_shared.map((f) => `- ${f.path} (${f.assessment}/${f.confidence})`).join("\n")
      : "- (none)";
    const forbidden = node.files_forbidden.length ? node.files_forbidden.map((p) => `- ${p}`).join("\n") : "- (none)";

    const lines = [
      `# Setup Phase for ${run.work_item_id}: ${run.work_item_name}`,
      "",
      "You are an execution agent running inside a dedicated git worktree created by Escapement Studio.",
      "This is the SETUP PHASE. Do NOT write any code yet.",
      "",
      "## Your task",
      "",
      "1. Read and understand the issue scope below",
      "2. Read relevant source files in the codebase to understand the implementation surface",
      `3. Update ${scratchpadName} with a detailed implementation plan:`,
      "   - Fill in the Summary section with your understanding",
      "   - Fill in Acceptance Criteria from the issue",
      "   - Replace the placeholder Implementation Plan checklist with specific, concrete tasks",
      "   - Each task should name the files it will touch",
      "   - Fill in the Affected Files section",
      "4. Surface any questions or concerns in the Questions / Concerns section",
      "5. If everything is clear, say so explicitly",
      "",
      "## Issue context",
      "",
      `Repo: ${workItem.repo ?? "(not set)"}`,
      `Issue URL: ${workItem.issue_url ?? "(not set)"}`,
      `Scope hint: ${workItem.scope_hint ?? "(not set)"}`,
      `Branch: ${node.branch}`,
      `Base ref: ${node.default_base_ref}`,
    ];

    if (issueBody) {
      lines.push("", "### Issue body", "", issueBody);
    } else {
      lines.push("", "(Issue body not available — use `gh issue view` or read from the issue URL if needed)");
    }

    lines.push(
      "",
      "## File ownership",
      "",
      "Files owned:",
      owned,
      "",
      "Files shared:",
      shared,
      "",
      "Files forbidden (you may READ these for context, but do NOT modify them):",
      forbidden,
    );

    if (projectContext) {
      lines.push("", "## Project conventions (from AGENTS.md / CLAUDE.md)", "", projectContext);
    }

    lines.push(
      "",
      "## Important",
      "",
      "- Do NOT start coding. This is setup only.",
      `- Update ${scratchpadName} with your detailed plan.`,
      "- The user will review your plan before coding begins.",
    );

    return lines.join("\n");
  }

  private buildDoWorkPrompt(
    run: ExecutionRunRecord,
    node: ExecutionDispatchNodePreview,
    workItem: WorkItemRecord,
    projectContext: string | null,
  ): string {
    const scratchpadName = `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md`;
    const lines = [
      `# Coding Phase for ${run.work_item_id}: ${run.work_item_name}`,
      "",
      `Your implementation plan in ${scratchpadName} has been approved. Now execute it.`,
      "",
      "## Workflow",
      "",
      `For each unchecked task in the ## Implementation Plan section of ${scratchpadName}:`,
      "",
      "1. **Implement** the change",
      `2. **Update ${scratchpadName}**: check off the task (\`- [x]\`), add a note to ## Work Log`,
      "3. **Commit** your changes:",
      `   - Stage specific files (never \`git add .\`, never stage ${scratchpadName})`,
      "   - Write a descriptive commit message",
      "   - Use conventional format: `type(scope): description`",
      "4. **Run quality checks** after each significant change:",
      "   - `npm run check` (TypeScript)",
      "   - `npm test` (if tests exist)",
      "   - `npm run build:web` (if frontend changes)",
      "5. Move to the next unchecked task",
      "",
      "## Rules",
      "",
      "- Work through tasks IN ORDER from the scratchpad",
      "- Commit after each logical task (not everything at the end)",
      `- NEVER commit or stage ${scratchpadName} — it is a local working document`,
      "- NEVER use `git add .` or `git add -A` — always stage specific files",
      "- Stay within your owned/shared files. Do NOT touch forbidden files.",
      `- If blocked on a task, note it in ${scratchpadName} ## Blockers and move on`,
      "",
      "## When finished",
      "",
      "After all tasks are complete:",
      "1. Run final quality checks (type check, tests, build)",
      `2. Update ${scratchpadName} ## Work Log with a completion summary`,
      "3. Provide a structured final summary:",
      "   - What you changed (files and purpose)",
      "   - Tests/checks you ran and their results",
      "   - Any remaining blockers or follow-up items",
    ];

    return lines.join("\n");
  }

  /** Legacy compat — delegates to buildDoWorkPrompt */
  private buildPrompt(workItem: WorkItemRecord, node: ExecutionDispatchNodePreview): string {
    const recent = this.runStore.listRecentRuns();
    const run = recent[0];
    if (run) return this.buildDoWorkPrompt(run, node, workItem, null);
    return `Execute work item ${workItem.id}: ${workItem.name}`;
  }

  /**
   * ADR 014 step 5: record a run ID on the plan metadata.
   *
   * Called at launch time (after the run record is persisted) so every
   * attempt — including blocked/failed starts — leaves a trace in the plan
   * metadata. Idempotent (deduped). Non-fatal: metadata write failures are
   * logged but must not abort the run.
   */
  private appendRunIdToPlanMetadata(workItemId: string, runId: string): void {
    try {
      const metadata = readPlanMetadata(this.artifactRoot, workItemId);
      if (!metadata) {
        return;
      }
      if (metadata.run_ids.includes(runId)) {
        return;
      }
      writePlanMetadata(this.artifactRoot, workItemId, {
        ...metadata,
        run_ids: [...metadata.run_ids, runId],
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        `appendRunIdToPlanMetadata: failed to record run ${runId} on plan for ${workItemId}: ` +
          this.getErrorMessage(error),
      );
    }
  }

  createHsmRunRecord(workItem: WorkItemRecord, options: {
    branch?: string | null;
    baseRef?: string | null;
    worktreePath?: string | null;
    prompt?: string;
  } = {}): ExecutionRunRecord {
    const branch = options.branch?.trim() || workItem.branch?.trim() || `${workItem.id}-branch`;
    const baseRef = options.baseRef?.trim() || getDefaultWorkingBranch(workItem.repo);
    const worktreePath = options.worktreePath?.trim() || this.worktreeService.getWorktreePath(branch);
    const run = this.createRunRecord({
      workItem,
      branch,
      baseRef,
      worktreePath,
      safetyChecks: [],
      prompt: options.prompt ?? "Created by WorkItemHsmService dispatch.",
      status: "queued",
      resultSummary: "Execution run queued by HSM dispatch.",
    });
    this.runStore.persistRun(run);
    return run;
  }

  private createRunRecord(input: {
    workItem: WorkItemRecord;
    branch: string;
    baseRef: string;
    worktreePath: string;
    safetyChecks: ExecutionSafetyCheck[];
    prompt: string;
    status: ExecutionRunRecord["status"];
    resultSummary?: string;
    errors?: Array<{ code: string; message: string }>;
  }): ExecutionRunRecord {
    const runId = `exec_${Date.now()}`;
    const createdAt = this.now();
    return {
      run_id: runId,
      run_type: "execution",
      work_item_id: input.workItem.id,
      work_item_name: input.workItem.name,
      status: input.status,
      created_at: createdAt,
      updated_at: createdAt,
      repo: input.workItem.repo,
      issue_url: input.workItem.issue_url,
      branch: input.branch,
      base_ref: input.baseRef,
      worktree_path: input.worktreePath,
      artifact_dir: runDir(this.artifactRoot, runId),
      prompt: input.prompt,
      progress_message: input.resultSummary ?? (input.status === "queued" ? "Execution run queued." : undefined),
      result_summary: input.resultSummary,
      activity_log: [],
      safety_checks: input.safetyChecks,
      errors: input.errors,
    };
  }

  private extractTextFromMessage(message: unknown): string | null {
    if (!message || typeof message !== "object") return null;
    const msg = message as Record<string, unknown>;
    // AgentMessage has content: ContentBlock[] where text blocks have { type: "text", text: string }
    const content = msg.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((block: unknown) => typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text")
        .map((block: unknown) => ((block as Record<string, unknown>).text as string) || "")
        .filter(Boolean);
      return texts.length > 0 ? texts.join("\n") : null;
    }
    if (typeof content === "string") return content || null;
    return null;
  }

  private readPullRequest(worktreePath: string, fallbackTitle: string, body: string): ExecutionPullRequestRecord {
    const raw = this.worktreeService.runGhIn(worktreePath, ["pr", "view", "--json", "number,url,title,body,baseRefName,headRefName,isDraft"]);
    const parsed = JSON.parse(raw) as {
      number?: number;
      url?: string;
      title?: string;
      body?: string;
      baseRefName?: string;
      headRefName?: string;
      isDraft?: boolean;
    };

    if (!Number.isInteger(parsed.number) || !parsed.url || !parsed.baseRefName || !parsed.headRefName) {
      throw new BadRequestException("Created pull request could not be read back from GitHub safely");
    }

    return {
      number: parsed.number!,
      url: parsed.url,
      title: parsed.title?.trim() || fallbackTitle,
      body: parsed.body ?? body,
      base_ref: parsed.baseRefName!,
      head_ref: parsed.headRefName!,
      is_draft: Boolean(parsed.isDraft),
      created_at: this.now(),
    };
  }

  private buildPullRequestTitle(workItem: WorkItemRecord): string {
    const issuePrefix = workItem.issue_number ? `[#${workItem.issue_number}] ` : "";
    return `${issuePrefix}${workItem.name}`;
  }

  private buildPullRequestBody(run: ExecutionRunRecord, workItem: WorkItemRecord, baseRef: string): string {
    const lines = [
      "## Summary",
      run.result_summary ?? run.progress_message ?? `Completed Studio execution run ${run.run_id}.`,
      "",
      "## Context",
      `- Work item: ${workItem.id}`,
      `- Issue: ${workItem.issue_url ?? "(not linked)"}`,
      `- Base branch: ${baseRef}`,
      `- Head branch: ${run.branch}`,
      `- Artifact dir: ${run.artifact_dir}`,
      `- Worktree: ${run.worktree_path}`,
    ];

    if (workItem.scope_hint) {
      lines.push(`- Scope hint: ${workItem.scope_hint}`);
    }

    lines.push("", "## Changed files");
    if (run.changed_files?.length) {
      lines.push(...run.changed_files.map((path) => `- \`${path}\``));
    } else {
      lines.push("- (not recorded)");
    }

    return lines.join("\n");
  }

  private autoStageAndCommit(run: ExecutionRunRecord, workItem: WorkItemRecord, commitMessage?: string): void {
    const status = this.worktreeService.runGitIn(run.worktree_path, ["status", "--porcelain"], { allowFailure: true }).trim();
    if (!status) {
      return; // working tree is clean, nothing to commit
    }

    this.logger.log(`Auto-staging and committing changes in ${run.worktree_path}`);
    this.worktreeService.runGitIn(run.worktree_path, ["add", "-A"]);

    // ADR 014 step 6: hard guard against committing `SCRATCHPAD_*.md`.
    // Replaces the silent `.gitignore` trick — disobedience is now visible.
    const stagedViolations = this.scratchpadService.findStagedScratchpadViolations(run.worktree_path);
    if (stagedViolations.length > 0) {
      this.runStore.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "auto_commit",
        paths: stagedViolations,
      });
      throw new BadRequestException(
        `auto_commit_blocked_by_scratchpad: the following scratchpad files are staged and must not be committed: ${stagedViolations.join(", ")}. ` +
          `Unstage them (git reset HEAD -- <path>) and retry. The canonical scratchpad lives at plans/<slug>/ and should not enter the worktree's git history.`,
      );
    }

    const message = commitMessage?.trim() || this.buildCommitMessage(workItem);
    this.worktreeService.runGitIn(run.worktree_path, ["commit", "-m", message]);

    // Refresh changed files after commit
    const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path);
    if (changedFiles.length > 0) {
      this.runStore.updateRun(run.run_id, { changed_files: changedFiles });
    }
  }

  private buildCommitMessage(workItem: WorkItemRecord): string {
    const issueRef = workItem.issue_number ? ` (#${workItem.issue_number})` : "";
    return `${workItem.name}${issueRef}`;
  }

  private syncActualFiles(workItemId: string, changedFiles: string[]): { ok: true; actual_files: string[] } | { ok: false; message: string } {
    try {
      const actualFiles = [...new Set(changedFiles.filter(Boolean))].sort();
      this.workItemsService.update(workItemId, { actual_files: actualFiles });
      return { ok: true, actual_files: actualFiles };
    } catch (error) {
      this.logger.warn(`Failed to sync actual_files for ${workItemId}: ${this.getErrorMessage(error)}`);
      return { ok: false, message: this.getErrorMessage(error) };
    }
  }

  private async markWorkItemInProgressOnLaunch(workItem: WorkItemRecord): Promise<{ workItem: WorkItemRecord; transitioned: boolean }> {
    // ADR 014 step 5: only launchable states transition to in_progress. The
    // eligibility safety check `launchable_state` already rejects anything
    // else before this method is reached; this guard is defensive.
    //
    // `ready` items launch after a human reviewer approved a plan via
    // `PlansService.approve`. `planned` items are a transitional fallback
    // until step 4 is broadly rolled out — the inline setup-phase scratchpad
    // synthesis still handles these.
    if (!this.isLaunchableState(workItem.state)) {
      return { workItem, transitioned: false };
    }

    await this.hsmService.dispatch(workItem.id, { type: "user.dispatch" });
    return {
      workItem: this.workItemsService.get(workItem.id),
      transitioned: true,
    };
  }

  /**
   * Transition a work item from in_progress back to ready.
   *
   * ADR 014 assigns the `in_progress → ready` transition to the execution
   * service (it's the service that owns launch and sees run results). For
   * MVP we expose it as a callable helper instead of auto-invoking it from
   * the run failure path — a human reviewer triggers it via the transition
   * endpoint when they decide the plan is still valid after a failed run.
   *
   * Future work can add conditional auto-invocation once error classification
   * is rich enough to distinguish "plan valid" from "plan needs rework"
   * (the latter going to `drafting`).
   */
  async transitionInProgressToReady(workItemId: string): Promise<WorkItemRecord> {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "in_progress") {
      throw new BadRequestException(
        `Cannot transition ${workItemId} from ${workItem.state} to ready (requires in_progress)`,
      );
    }
    await this.hsmService.dispatch(workItemId, { type: "user.investigate" });
    return this.workItemsService.get(workItemId);
  }

  /**
   * Transition a work item from in_progress back to drafting.
   *
   * ADR 014 step 5: mirror of `transitionInProgressToReady` for the "plan
   * needs rework" failure return path. Both transitions remain purely
   * operator-triggered in step 5 — automatic failure classification is
   * deferred to step 7 (run disposition).
   */
  async transitionInProgressToDrafting(workItemId: string): Promise<WorkItemRecord> {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "in_progress") {
      throw new BadRequestException(
        `Cannot transition ${workItemId} from ${workItem.state} to drafting (requires in_progress)`,
      );
    }
    await this.hsmService.dispatch(workItemId, { type: "user.start_draft" });
    return this.workItemsService.get(workItemId);
  }

  private async resolvePullRequestFromWorkItem(workItem: WorkItemRecord) {
    const branch = workItem.branch?.trim();
    if (!branch) {
      throw new BadRequestException(`Work item ${workItem.id} is missing branch metadata required to resolve its pull request`);
    }

    const pullRequest = await this.githubService.findPullRequestForBranch(workItem.repo ?? "", branch);
    if (!pullRequest) {
      throw new BadRequestException(`No pull request was found for branch ${branch}`);
    }

    return pullRequest;
  }

  private findRecentRunForSync(workItem: WorkItemRecord, pullRequestNumber: number): ExecutionRunRecord | null {
    return this.runStore.listRecentRuns().find((run) => {
      if (run.work_item_id !== workItem.id) {
        return false;
      }
      if (run.pull_request?.number === pullRequestNumber) {
        return true;
      }
      return run.branch === workItem.branch;
    }) ?? null;
  }

  private selectActualFilesForMergeSync(
    input: SyncMergedExecutionDto,
    workItem: WorkItemRecord,
    matchedRun: ExecutionRunRecord | null,
  ): { files: string[]; source: "input" | "work_item" | "run" } {
    if (Array.isArray(input.actual_files) && input.actual_files.length > 0) {
      return { files: this.uniqueSorted(input.actual_files), source: "input" };
    }
    if (workItem.actual_files.length > 0) {
      return { files: this.uniqueSorted(workItem.actual_files), source: "work_item" };
    }
    if (matchedRun?.changed_files?.length) {
      return { files: this.uniqueSorted(matchedRun.changed_files), source: "run" };
    }
    return { files: [], source: "work_item" };
  }

  private buildMergedWorkItemMeta(
    workItem: WorkItemRecord,
    pullRequest: {
      number: number;
      url: string;
      title: string;
      state: string;
      base_ref: string;
      head_ref: string;
      merged_at: string | null;
      merge_commit_sha: string | null;
    },
    runId: string | null,
    actualFilesSource: "input" | "work_item" | "run",
  ): Record<string, unknown> {
    return {
      ...workItem.meta,
      studio_post_merge_sync: {
        synced_at: this.now(),
        run_id: runId,
        actual_files_source: actualFilesSource,
        pull_request: {
          number: pullRequest.number,
          url: pullRequest.url,
          title: pullRequest.title,
          state: pullRequest.state,
          base_ref: pullRequest.base_ref,
          head_ref: pullRequest.head_ref,
          merged_at: pullRequest.merged_at,
          merge_commit_sha: pullRequest.merge_commit_sha,
        },
      },
    };
  }

  private async safeStageManagedBlockSync(workItemId: string) {
    try {
      const staged = await this.githubService.stageManagedBlockSync(workItemId);
      return {
        work_item_id: staged.work_item_id,
        based_on_body_hash: staged.based_on_body_hash,
        operations: staged.operations,
      };
    } catch (error) {
      this.logger.warn(`Failed to stage managed block sync for ${workItemId}: ${this.getErrorMessage(error)}`);
      return null;
    }
  }

  private toExecutionPullRequestRecord(pullRequest: {
    number: number;
    url: string;
    title: string;
    body: string;
    base_ref: string;
    head_ref: string;
    is_draft: boolean;
    state: string;
    merged_at: string | null;
    merge_commit_sha: string | null;
  }): ExecutionPullRequestRecord {
    return {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      body: pullRequest.body,
      base_ref: pullRequest.base_ref,
      head_ref: pullRequest.head_ref,
      is_draft: pullRequest.is_draft,
      created_at: this.now(),
      state: pullRequest.state,
      merged_at: pullRequest.merged_at,
      merge_commit_sha: pullRequest.merge_commit_sha,
    };
  }

  private samePullRequestRecord(left: ExecutionPullRequestRecord | undefined, right: ExecutionPullRequestRecord): boolean {
    if (!left) {
      return false;
    }

    return left.number === right.number
      && left.url === right.url
      && left.title === right.title
      && left.body === right.body
      && left.base_ref === right.base_ref
      && left.head_ref === right.head_ref
      && left.is_draft === right.is_draft
      && left.state === right.state
      && (left.merged_at ?? null) === (right.merged_at ?? null)
      && (left.merge_commit_sha ?? null) === (right.merge_commit_sha ?? null);
  }

  private normalizeNullableString(value?: string | null): string | null | undefined {
    if (typeof value === "undefined") {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  private uniqueSorted(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  }

  private extractReasoningSummary(assistantText: string): string | null {
    if (!assistantText || assistantText.length < 20) {
      return null;
    }
    // Take the first meaningful paragraph (up to ~300 chars) as the reasoning summary
    const lines = assistantText.split("\n").filter((l) => l.trim().length > 0);
    const summary = lines.slice(0, 4).join(" ").trim();
    if (summary.length <= 300) {
      return summary;
    }
    return summary.slice(0, 297) + "...";
  }

  private safeGetWorkItem(id: string): WorkItemRecord | null {
    try {
      return this.workItemsService.get(id);
    } catch {
      return null;
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Parse a single line from `git status --short` into a file path, or null for empty lines. */
export function parseChangedFilePath(line: string): string | null {
  if (!line.trim()) {
    return null;
  }

  const path = line.length > 3 ? line.slice(3) : line;
  const renameSeparator = " -> ";
  const renamedIndex = path.indexOf(renameSeparator);
  if (renamedIndex >= 0) {
    return path.slice(renamedIndex + renameSeparator.length).trim();
  }

  return path.trim();
}
