import { BadRequestException, Inject, Injectable, Logger, MessageEvent } from "@nestjs/common";
import { createAgentSession, createCodingTools, SessionManager, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Observable, Subject } from "rxjs";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import {
  archiveDir,
  archivesRoot,
  canonicalScratchpadPath,
  ensurePlanDir,
  planDir,
  readPlanMetadata,
  runDir,
  workItemSlug,
  worktreesRoot,
  writePlanMetadata,
} from "../../lib/context-layout.js";
import { fetchIssueBody } from "../../lib/github-cli.js";
import { getDefaultWorkingBranch, listDefaultWorkingBranches } from "./default-working-branches.js";
import { GitHubService } from "../github/github.service.js";
import { GraphService } from "../graph/graph.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import type {
  ActivityLogEntry,
  ActivityLogEntryKind,
  ChecklistItem,
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
  ExecutionStatusEvent,
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
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly streamId = "execution-runs";
  private readonly eventSubject = new Subject<MessageEvent>();
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  private readonly worktreeRoot = worktreesRoot(this.artifactRoot);
  private readonly recentRuns: ExecutionRunRecord[] = [];
  private readonly recentRunLimit = 16;
  // No cap on activity log — full history preserved in status.json
  private eventCounter = 0;
  /** Active agent sessions keyed by run_id — kept alive while run is active */
  private readonly activeSessions = new Map<string, import("@mariozechner/pi-coding-agent").AgentSession>();
  // Chat history derived from activity_log (agent_message + user_message entries)
  /** Disambiguation gate resolvers — calling the stored function unblocks the coding phase */
  private readonly disambiguationGates = new Map<string, { resolve: (additionalContext?: string) => void }>();
  /** Last-emitted checklist snapshots per run — used for dedup */
  private readonly lastChecklistSnapshots = new Map<string, string>();

  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
  ) {
    this.githubService.registerPullRequestTruthRefresher((pullRequest, options) => this.refreshPullRequestTruth(pullRequest, options));
  }

  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.eventSubject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  listRecentRuns(): ExecutionRunRecord[] {
    return [...this.recentRuns].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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

    for (const run of this.listRecentRuns()) {
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

      const nextRun = this.updateRun(run.run_id, { pull_request: nextPullRequest });
      if (!nextRun) {
        continue;
      }

      this.appendEvent(nextRun, {
        type: "pull_request_truth_refreshed",
        pull_request: {
          number: nextPullRequest.number,
          state: nextPullRequest.state,
          merged_at: nextPullRequest.merged_at,
          merge_commit_sha: nextPullRequest.merge_commit_sha,
        },
      });
      this.writeSummary(nextRun);
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
          const worktreePath = this.getWorktreePath(node.branch);
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
          worktree_path: this.getWorktreePath(node.branch),
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
      const worktreePath = node?.worktree_path ?? this.getWorktreePath(branch);
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
      this.persistRun(run);
      this.emitRun("execution_result", run);
      return { accepted: false, run };
    }

    const launchState = this.markWorkItemInProgressOnLaunch(workItem);
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

    this.persistRun(run);
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
      const failedRun = this.updateRun(run.run_id, {
        status: "error",
        completed_at: this.now(),
        progress_message: `Execution failed: ${this.getErrorMessage(error)}`,
        result_summary: `Execution failed: ${this.getErrorMessage(error)}`,
        errors: [{ code: "execution_failed", message: this.getErrorMessage(error) }],
      });
      if (failedRun) {
        this.writeSummary(failedRun);
        this.appendEvent(failedRun, { type: "run_failed", error: this.getErrorMessage(error) });
        this.emitRun("execution_result", failedRun);
      }
    });

    return { accepted: true, run };
  }

  async createPullRequest(input: CreateExecutionPullRequestDto): Promise<CreateExecutionPullRequestResult> {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.getRun(runId);
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
    const prStagedViolations = this.findStagedScratchpadViolations(run.worktree_path);
    if (prStagedViolations.length > 0) {
      this.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request",
        paths: prStagedViolations,
      });
      throw new BadRequestException(
        `pull_request_blocked_by_scratchpad: the following scratchpad files are staged and must not be committed before opening a pull request: ${prStagedViolations.join(", ")}. ` +
          `Unstage them (git reset HEAD -- <path>) before retrying.`,
      );
    }

    const committedViolations = this.findCommittedScratchpadViolations(run.worktree_path, baseRef);
    if (committedViolations.length > 0) {
      this.appendEvent(run, {
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
    const aheadCount = this.countCommitsAhead(run.worktree_path, baseRef, run.branch);
    if (aheadCount === 0) {
      throw new BadRequestException(`Branch ${run.branch} has no commits ahead of ${baseRef}; nothing is ready to open as a pull request`);
    }

    this.runGitIn(run.worktree_path, ["push", "--set-upstream", "origin", run.branch]);
    this.runGhIn(run.worktree_path, [
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
    const nextRun = this.updateRun(run.run_id, { pull_request: pullRequest }) ?? run;
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "pull-request.json"), JSON.stringify(pullRequest, null, 2), "utf8");
    this.appendEvent(nextRun, { type: "pull_request_created", pull_request: pullRequest });
    this.writeSummary(nextRun);

    // Update work item: set state to open_pr and store PR metadata
    try {
      const existingMeta = workItem.meta ?? {};
      this.workItemsService.update(run.work_item_id, {
        state: "open_pr",
        branch: run.branch,
        meta: {
          ...existingMeta,
          pull_request: {
            number: pullRequest.number,
            url: pullRequest.url,
            title: pullRequest.title,
            is_draft: pullRequest.is_draft,
            head_ref: pullRequest.head_ref,
            base_ref: pullRequest.base_ref,
            created_at: pullRequest.created_at,
          },
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
    this.workItemsService.update(workItem.id, {
      state: "merged_pr",
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
      const syncedRun = this.updateRun(matchedRun.run_id, { pull_request: nextPullRequest }) ?? matchedRun;
      this.appendEvent(syncedRun, {
        type: "post_merge_sync_completed",
        work_item_id: updatedWorkItem.id,
        pull_request: nextPullRequest,
        actual_files: actualFilesSelection.files,
      });
      this.writeSummary(syncedRun);
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
      cleanup: matchedRun ? this.safeCleanupWorktree(matchedRun) : null,
    };
  }

  cleanupWorktree(input: CleanupWorktreeDto): CleanupWorktreeResult {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.recentRuns.find((r) => r.run_id === runId);
    if (!run) {
      throw new BadRequestException(`No recent run found with id ${runId}`);
    }

    if (run.status === "running" || run.status === "preparing" || run.status === "disambiguating") {
      throw new BadRequestException(`Cannot cleanup worktree for run ${runId} — status is ${run.status}`);
    }

    return this.removeWorktreeAndBranch(run);
  }

  cleanupAllStale(): CleanupWorktreeResult[] {
    const results: CleanupWorktreeResult[] = [];
    for (const run of this.recentRuns) {
      if (run.status !== "running" && run.status !== "preparing" && run.status !== "queued") {
        const result = this.safeCleanupWorktree(run);
        if (result) {
          results.push(result);
        }
      }
    }
    return results;
  }

  private safeCleanupWorktree(run: ExecutionRunRecord): CleanupWorktreeResult | null {
    try {
      return this.removeWorktreeAndBranch(run);
    } catch (error) {
      this.logger.warn(`Failed to cleanup worktree for run ${run.run_id}: ${error}`);
      return null;
    }
  }

  private removeWorktreeAndBranch(run: ExecutionRunRecord): CleanupWorktreeResult {
    const worktreeRemoved = this.removeWorktreeDir(run.worktree_path);
    const branchRemoved = this.removeLocalBranch(run.branch);

    if (worktreeRemoved || branchRemoved) {
      this.logger.log(`Cleaned up run ${run.run_id}: worktree=${worktreeRemoved}, branch=${branchRemoved}`);
    }

    return {
      run_id: run.run_id,
      branch: run.branch,
      worktree_path: run.worktree_path,
      worktree_removed: worktreeRemoved,
      branch_removed: branchRemoved,
    };
  }

  private removeWorktreeDir(worktreePath: string): boolean {
    if (!existsSync(worktreePath)) {
      return false;
    }
    try {
      this.runGit(["worktree", "remove", worktreePath, "--force"]);
      return true;
    } catch {
      // Fallback: remove directory and prune
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        this.runGit(["worktree", "prune"]);
        return true;
      } catch (error) {
        this.logger.warn(`Failed to remove worktree at ${worktreePath}: ${error}`);
        return false;
      }
    }
  }

  private removeLocalBranch(branch: string): boolean {
    try {
      this.runGit(["branch", "-D", branch]);
      return true;
    } catch {
      return false;
    }
  }

  async resolveDisambiguation(input: ResolveDisambiguationDto): Promise<ResolveDisambiguationResult> {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.getRun(runId);
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
    let run = this.updateRun(initialRun.run_id, {
      status: "preparing",
      progress_message: "Creating isolated git worktree.",
    });
    if (!run) {
      return;
    }
    this.appendEvent(run, { type: "run_preparing" });
    this.emitRun("execution_status", run);

    // --- Create worktree ---
    this.runGit(["worktree", "add", run.worktree_path, "-b", run.branch, run.base_ref]);
    this.pushActivity(run.run_id, "status_change", `Worktree created at ${run.worktree_path}`, `Branch: ${run.branch}, Base: ${run.base_ref}`);
    this.appendEvent(run, { type: "worktree_created", worktree_path: run.worktree_path, branch: run.branch, base_ref: run.base_ref });

    // --- Install dependencies in worktree ---
    if (existsSync(join(run.worktree_path, "package.json"))) {
      this.pushActivity(run.run_id, "status_change", "Installing dependencies in worktree...");
      this.emitRun("execution_status", run);
      try {
        execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: run.worktree_path, encoding: "utf8", timeout: 120000, stdio: "pipe" });
        this.pushActivity(run.run_id, "status_change", "Dependencies installed.");
      } catch (npmErr) {
        this.pushActivity(run.run_id, "info", `npm ci failed, trying npm install: ${this.getErrorMessage(npmErr).slice(0, 200)}`);
        try {
          execFileSync("npm", ["install", "--ignore-scripts"], { cwd: run.worktree_path, encoding: "utf8", timeout: 120000, stdio: "pipe" });
          this.pushActivity(run.run_id, "status_change", "Dependencies installed (via npm install).");
        } catch {
          this.pushActivity(run.run_id, "info", "Dependency installation failed — agent may not be able to run quality checks.");
        }
      }
    }

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
    const scratchpadResult = this.writeScratchpad(run, node);
    const scratchpadPath = scratchpadResult.path;
    const hasApprovedPlan = scratchpadResult.source === "canonical_ready";
    this.pushActivity(
      run.run_id,
      "status_change",
      hasApprovedPlan
        ? `Approved plan loaded from canonical scratchpad at ${scratchpadPath}`
        : `Scratchpad written to ${scratchpadPath}`,
    );
    this.appendEvent(run, { type: "scratchpad_written", path: scratchpadPath });
    this.emitChecklistIfChanged(run);

    // --- Create agent session ---
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: run.worktree_path,
      sessionManager: SessionManager.inMemory(run.worktree_path),
      tools: createCodingTools(run.worktree_path),
    });

    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    run = this.updateRun(initialRun.run_id, {
      status: "running",
      started_at: this.now(),
      session_id: session.sessionId,
      progress_message: "Agent session started — setup phase.",
    })!;
    this.pushActivity(run.run_id, "status_change", "Agent session started.");
    this.appendEvent(run, { type: "session_started", session_id: session.sessionId });
    this.emitRun("execution_status", run);

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
        this.appendEvent(run, { type: "setup_phase_skipped" });
      }
      if (shouldRunSetupPhase) {
        run = this.updateRun(runId, {
          status: "running",
          progress_message: "Setup phase — agent is analyzing the issue and planning implementation.",
        })!;
        this.pushActivity(runId, "status_change", "Setup phase started — agent analyzing issue and codebase.");
        this.appendEvent(run, { type: "setup_phase_started" });
        this.emitRun("execution_status", run);

        const setupPrompt = this.buildSetupPrompt(run, node, workItem, issueBody, projectContext);
        await session.prompt(setupPrompt);

        // Sync the agent's scratchpad edits back to the canonical plan file
        // (end of setup phase, before the approval gate).
        this.syncScratchpadToCanonical(run);

        // Setup prompt finished — now switch to disambiguating so the UI shows the approval gate
        this.emitChecklistIfChanged(run);
        run = this.updateRun(runId, {
          status: "disambiguating",
          progress_message: "Setup complete. Review the implementation plan and approve to start coding.",
        })!;
        this.pushActivity(runId, "info", "Setup complete — implementation plan ready for review.");
        this.appendEvent(run, { type: "setup_phase_complete" });
        this.emitRun("execution_status", run);

        // Block until the user approves — gate is now ready
        const additionalContext = await new Promise<string | undefined>((resolve) => {
          this.disambiguationGates.set(runId, { resolve });
        });
        this.appendEvent(run, { type: "setup_approved" });

        if (additionalContext) {
          await session.prompt(
            `The user provided feedback on your plan:\n\n${additionalContext}\n\nUpdate the ${scratchpadName} implementation plan accordingly, then confirm you're ready to start coding.`
          );
          this.syncScratchpadToCanonical(run);
          this.emitChecklistIfChanged(run);
        }

        run = this.updateRun(runId, {
          status: "running",
          progress_message: "Plan approved — coding phase started.",
        })!;
        this.pushActivity(runId, "status_change", "Plan approved. Coding phase started.");
        this.emitRun("execution_status", run);
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
      this.syncScratchpadToCanonical(run);

      this.emitChecklistIfChanged(run);
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
    const changedFiles = this.listChangedFiles(run.worktree_path);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "response.json"), JSON.stringify({ assistant_text: assistantText, changed_files: changedFiles, actual_files_sync: actualFilesSync }, null, 2), "utf8");

    // The canonical scratchpad at plans/<slug>/SCRATCHPAD_<slug>.md is the
    // post-run snapshot — synced above at each phase boundary. No separate
    // scratchpad-final.md is written under the run artifact dir anymore.

    this.pushActivity(run.run_id, "status_change", `Execution completed. ${changedFiles.length} file(s) changed.`);
    run = this.updateRun(initialRun.run_id, {
      status: "completed",
      completed_at: this.now(),
      progress_message: actualFilesSync.ok ? "Execution run completed. actual_files updated on the work item." : "Execution run completed.",
      result_summary: actualFilesSync.ok ? `${assistantText}\n\nactual_files synced: ${changedFiles.length} file(s).` : assistantText,
      changed_files: changedFiles,
    })!;
    this.writeSummary(run, node);
    this.appendEvent(run, { type: "run_completed", changed_files: changedFiles, actual_files_sync: actualFilesSync });
    this.emitRun("execution_result", run);
  }

  getRunActivityLog(runId: string): ActivityLogEntry[] {
    const run = this.getRun(runId);
    return run?.activity_log ?? [];
  }

  getRunChatHistory(runId: string): RunChatHistory {
    const run = this.getRun(runId);
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
    const run = this.getRun(runId);
    if (!run) {
      return { run_id: runId, items: [], completed: 0, total: 0 };
    }
    const items = this.readChecklistFromWorktree(run);
    return {
      run_id: runId,
      items,
      completed: items.filter((i) => i.checked).length,
      total: items.length,
    };
  }

  getRunScratchpad(runId: string): { run_id: string; content: string | null } {
    const run = this.getRun(runId);
    if (!run) {
      return { run_id: runId, content: null };
    }

    // Prefer the canonical plan file (source of truth, synced at each phase boundary)
    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
    if (existsSync(canonicalPath)) {
      return { run_id: runId, content: readFileSync(canonicalPath, "utf8") };
    }

    // Fall back to the live worktree copy (active run before first sync-back)
    const slug = workItemSlug(run.work_item_id);
    const worktreePath = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    if (existsSync(worktreePath)) {
      return { run_id: runId, content: readFileSync(worktreePath, "utf8") };
    }

    return { run_id: runId, content: null };
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

    const run = this.getRun(runId);
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
        this.appendEvent(run, { type: "follow_up_sent", delivery, message_length: message.length });
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
        const updatedRun = this.updateRun(runId, {
          status: "running",
          progress_message: "Follow-up turn running.",
        });
        if (!updatedRun) {
          return { accepted: false, run_id: runId, delivery: "new_turn", message, error: "Failed to update run status" };
        }

        // Fire-and-forget the follow-up turn
        void this.executeFollowUpTurn(updatedRun, message).catch((error) => {
          this.pushActivity(runId, "error", `Follow-up turn failed: ${this.getErrorMessage(error)}`);
          this.updateRun(runId, {
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
      this.syncScratchpadToCanonical(run);
      this.emitChecklistIfChanged(run);
    } finally {
      unsubscribe();
      this.activeSessions.delete(run.run_id);
      session.dispose();
    }

    const assistantText = session.getLastAssistantText()?.trim() ?? "Follow-up turn completed without a summary.";
    this.pushActivity(run.run_id, "agent_message", assistantText);

    const changedFiles = this.listChangedFiles(run.worktree_path);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);

    this.pushActivity(run.run_id, "follow_up", `Follow-up turn completed. ${changedFiles.length} file(s) changed.`);
    const nextRun = this.updateRun(run.run_id, {
      status: "completed",
      completed_at: this.now(),
      progress_message: "Follow-up turn completed.",
      result_summary: assistantText,
      changed_files: changedFiles,
    });
    if (nextRun) {
      this.writeSummary(nextRun);
      this.appendEvent(nextRun, { type: "follow_up_turn_completed", changed_files: changedFiles, actual_files_sync: actualFilesSync });
      this.emitRun("execution_result", nextRun);
    }
  }

  // Chat messages are now stored as agent_message/user_message entries in the activity_log

  private handleSessionEvent(runId: string, event: AgentSessionEvent) {
    const run = this.getRun(runId);
    if (!run) {
      return;
    }

    const toolName = "toolName" in event ? event.toolName ?? null : null;
    if (event.type === "tool_execution_start") {
      this.appendEvent(run, { type: event.type, tool_name: toolName });
      this.pushActivity(runId, "tool_start", `Tool started: ${toolName ?? "unknown"}`);
      this.updateRun(runId, { progress_message: `${toolName ?? "tool"} running…` });
      return;
    }

    if (event.type === "tool_execution_end") {
      this.appendEvent(run, { type: event.type, tool_name: toolName });
      this.pushActivity(runId, "tool_end", `Tool finished: ${toolName ?? "unknown"}`);
      this.updateRun(runId, { progress_message: `${toolName ?? "tool"} finished.` });
      this.emitChecklistIfChanged(run);
      return;
    }

    if (event.type === "message_end") {
      const message = "message" in event ? event.message : null;
      const text = this.extractTextFromMessage(message);
      this.appendEvent(run, { type: event.type, text: text?.slice(0, 2000) ?? null });
      if (text) {
        this.pushActivity(runId, "agent_message", text);
        this.emitRun("execution_status", run);
      }
      return;
    }

    if (event.type === "agent_start" || event.type === "turn_start") {
      this.appendEvent(run, { type: event.type });
      this.pushActivity(runId, "turn_start", "Execution turn started.");
      this.updateRun(runId, { progress_message: "Execution turn started." });
      return;
    }

    if (event.type === "agent_end" || event.type === "turn_end") {
      this.appendEvent(run, { type: event.type });
      this.pushActivity(runId, "turn_end", "Execution turn completed.");
      this.updateRun(runId, { progress_message: "Execution turn completed." });
    }
  }

  /**
   * Parse checklist items from the ## Implementation Plan section of a scratchpad.
   * Only matches `- [ ]` and `- [x]` lines within that section.
   */
  parseImplementationPlanChecklist(content: string): ChecklistItem[] {
    const lines = content.split("\n");
    const items: ChecklistItem[] = [];
    let inSection = false;

    for (const line of lines) {
      // Detect heading boundaries
      if (/^##\s/.test(line)) {
        inSection = /^##\s+Implementation Plan/i.test(line);
        continue;
      }
      if (inSection) {
        const match = line.match(/^\s*-\s+\[([\sxX])\]\s+(.+)$/);
        if (match) {
          items.push({
            checked: match[1].toLowerCase() === "x",
            text: match[2].trim(),
          });
        }
      }
    }
    return items;
  }

  private readChecklistFromWorktree(run: ExecutionRunRecord): ChecklistItem[] {
    const slug = workItemSlug(run.work_item_id);
    const scratchpadPath = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    if (!existsSync(scratchpadPath)) {
      return [];
    }
    try {
      const content = readFileSync(scratchpadPath, "utf8");
      return this.parseImplementationPlanChecklist(content);
    } catch {
      return [];
    }
  }

  private emitChecklistIfChanged(run: ExecutionRunRecord): void {
    const items = this.readChecklistFromWorktree(run);
    const snapshot: ExecutionChecklistSnapshot = {
      run_id: run.run_id,
      items,
      completed: items.filter((i) => i.checked).length,
      total: items.length,
    };
    const key = JSON.stringify(snapshot.items);
    if (this.lastChecklistSnapshots.get(run.run_id) === key) {
      return; // No change
    }
    this.lastChecklistSnapshots.set(run.run_id, key);

    const envelope = {
      event_id: `evt_${++this.eventCounter}`,
      stream_id: this.streamId,
      timestamp: this.now(),
      event_type: "execution_checklist",
      session_id: run.run_id,
      turn_id: null,
      payload: snapshot,
    };
    this.eventSubject.next({
      type: envelope.event_type,
      data: JSON.stringify(envelope),
      id: envelope.event_id,
    });
  }

  private pushActivity(runId: string, kind: ActivityLogEntryKind, message: string, detail?: string) {
    const run = this.getRun(runId);
    if (!run) {
      return;
    }
    const entry: ActivityLogEntry = { timestamp: this.now(), kind, message, ...(detail ? { detail } : {}) };
    run.activity_log.push(entry);
  }

  private resolveLaunchEligibility(
    workItem: WorkItemRecord,
    options: { baseRef?: string; plan?: ReturnType<GraphService["getPlan"]> } = {},
  ): ExecutionLaunchEligibility {
    const baseRef = options.baseRef?.trim() || getDefaultWorkingBranch(workItem.repo);
    const plan = options.plan ?? this.graphService.getPlan(workItem.repo ?? undefined);
    const groupedNode = this.findPlannedNode(plan, workItem.id);
    const branch = groupedNode?.node.branch ?? workItem.branch ?? `${workItem.id}-branch`;
    const worktreePath = this.getWorktreePath(branch);
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
      safetyChecks.push(...this.evaluateSafety(branch, worktreePath, baseRef));
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

  private evaluateSafety(branch: string, worktreePath: string, baseRef = getDefaultWorkingBranch(null)): ExecutionSafetyCheck[] {
    const checks: ExecutionSafetyCheck[] = [];
    checks.push(this.checkTrackedRepoClean());
    checks.push(this.checkBaseRef(baseRef));
    checks.push(this.checkBranchAvailable(branch));
    checks.push(this.checkWorktreePathAvailable(worktreePath));
    checks.push(this.checkPathBounded(worktreePath));
    return checks;
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
    return state === "ready" || state === "planned";
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

  private checkTrackedRepoClean(): ExecutionSafetyCheck {
    const output = this.runGit(["status", "--porcelain", "--untracked-files=no"], { allowFailure: true });
    return output.trim().length === 0
      ? { code: "tracked_repo_clean", status: "pass", message: "Repo has no tracked changes that would interfere with dispatch." }
      : { code: "tracked_repo_clean", status: "warn", message: "Repo has tracked local changes, but execution still uses an isolated worktree and will not mutate the main checkout." };
  }

  private checkBaseRef(baseRef: string): ExecutionSafetyCheck {
    const ok = this.runGit(["rev-parse", "--verify", baseRef], { allowFailure: true }).trim().length > 0;
    return ok
      ? { code: "base_ref_exists", status: "pass", message: `Base ref ${baseRef} is available.` }
      : { code: "base_ref_exists", status: "fail", message: `Base ref ${baseRef} was not found.` };
  }

  private checkBranchAvailable(branch: string): ExecutionSafetyCheck {
    const existing = this.runGit(["branch", "--list", branch], { allowFailure: true }).trim();
    return existing.length === 0
      ? { code: "branch_available", status: "pass", message: `Branch ${branch} is available for a new worktree.` }
      : { code: "branch_available", status: "fail", message: `Branch ${branch} already exists locally.` };
  }

  private checkWorktreePathAvailable(worktreePath: string): ExecutionSafetyCheck {
    const listed = this.runGit(["worktree", "list", "--porcelain"], { allowFailure: true });
    return listed.includes(`worktree ${worktreePath}`)
      ? { code: "worktree_path_available", status: "fail", message: `Worktree path ${worktreePath} is already in use.` }
      : { code: "worktree_path_available", status: "pass", message: "Target worktree path is available." };
  }

  private checkPathBounded(worktreePath: string): ExecutionSafetyCheck {
    const boundedRoot = resolve(this.worktreeRoot);
    const target = resolve(worktreePath);
    return target.startsWith(`${boundedRoot}/`) || target === boundedRoot
      ? { code: "worktree_path_bounded", status: "pass", message: "Target worktree path is inside the configured execution worktree root." }
      : { code: "worktree_path_bounded", status: "fail", message: "Target worktree path escaped the configured execution worktree root." };
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
    const run = this.recentRuns[this.recentRuns.length - 1];
    if (run) return this.buildDoWorkPrompt(run, node, workItem, null);
    return `Execute work item ${workItem.id}: ${workItem.name}`;
  }

  /** Build a structured scratchpad markdown document for the execution worktree. */
  buildScratchpad(run: ExecutionRunRecord, node: ExecutionDispatchNodePreview): string {
    const owned = node.files_owned.length
      ? node.files_owned.map((path) => `- ${path}`).join("\n")
      : "- (none predicted)";
    const shared = node.files_shared.length
      ? node.files_shared.map((file) => `- ${file.path} (${file.assessment}/${file.confidence})`).join("\n")
      : "- (none)";
    const forbidden = node.files_forbidden.length
      ? node.files_forbidden.map((path) => `- ${path}`).join("\n")
      : "- (none)";

    return [
      `# Scratchpad: ${run.work_item_id} — ${run.work_item_name}`,
      "",
      "## Context",
      `- **Repo:** ${run.repo ?? "(not set)"}`,
      `- **Issue:** ${run.issue_url ?? "(not linked)"}`,
      `- **Branch:** ${run.branch}`,
      `- **Base ref:** ${run.base_ref}`,
      `- **Scope hint:** ${node.scope_hint ?? "(not set)"}`,
      `- **Created:** ${run.created_at}`,
      "",
      "## File Ownership",
      "",
      "### Owned",
      owned,
      "",
      "### Shared",
      shared,
      "",
      "### Forbidden",
      forbidden,
      "",
      "## Acceptance Criteria",
      "<!-- Fill in from the issue body during setup phase -->",
      "",
      "- [ ] (to be filled by setup phase)",
      "",
      "## Implementation Plan",
      "<!-- The setup phase agent will replace these with specific, concrete tasks -->",
      "",
      "- [ ] Analyze scope and identify changes needed",
      "- [ ] Implement changes",
      "- [ ] Run tests / verify",
      "- [ ] Summarize results",
      "",
      "## Affected Files",
      "<!-- List specific files that will be modified, with what changes -->",
      "",
      "## Quality Checks",
      "- [ ] TypeScript compilation passes (`npm run check`)",
      "- [ ] Tests pass (`npm test`)",
      "- [ ] Build succeeds (`npm run build:web`)",
      "",
      "## Questions / Concerns",
      "<!-- Surface any ambiguities during setup — resolve with user before coding -->",
      "",
      "## Work Log",
      "",
      `### ${new Date().toISOString().slice(0, 10)} - Setup`,
      "- Scratchpad created by Studio execution service",
      `- Branch: ${run.branch}`,
      "",
      "## Blockers",
      "",
    ].join("\n");
  }

  /**
   * Sync the agent's worktree scratchpad back to the canonical plan file.
   *
   * Called at each phase boundary in executeRun. If the worktree copy is
   * missing (e.g. the agent deleted it), logs a warning and leaves the
   * canonical file unchanged — the canonical retains its last-known-good
   * state.
   */
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

  private syncScratchpadToCanonical(run: ExecutionRunRecord): void {
    const slug = workItemSlug(run.work_item_id);
    const worktreeScratchpad = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    const canonical = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
    if (!existsSync(worktreeScratchpad)) {
      this.logger.warn(
        `syncScratchpadToCanonical: worktree scratchpad missing for run ${run.run_id} ` +
          `at ${worktreeScratchpad}; canonical left unchanged.`,
      );
      return;
    }
    writeFileSync(canonical, readFileSync(worktreeScratchpad, "utf8"), "utf8");
  }

  /**
   * Seed the worktree scratchpad from the canonical plan file.
   *
   * ADR 014 step 2/4/5: the canonical scratchpad lives at
   * `plans/<slug>/SCRATCHPAD_<slug>.md` and is the source of truth.
   *
   * After ADR 014 step 4 lands, a work item that reached `ready` state via
   * `PlansService.approve` already has an approved canonical scratchpad —
   * no skeleton synthesis happens here and the setup-phase agent turn is
   * skipped upstream (caller uses the returned `source` field).
   *
   * The fallback path (no plan metadata or plan state is null/drafting, for
   * `planned` items under the step 5 transitional gate) still generates a
   * skeleton via `buildScratchpad` and writes it to canonical. This path
   * goes away when every launch goes through prepare→approve.
   *
   * Returns `{ path, source }`:
   *   - `canonical_ready`    — plan was approved, content came from canonical
   *   - `carried_forward`    — canonical existed but plan state was not `ready`
   *                            (e.g. legacy plan dir with no metadata state)
   *   - `synthesized`        — no canonical file existed; skeleton generated
   */
  private writeScratchpad(
    run: ExecutionRunRecord,
    node: ExecutionDispatchNodePreview,
  ): { path: string; source: "canonical_ready" | "carried_forward" | "synthesized" } {
    ensurePlanDir(this.artifactRoot, run.work_item_id);
    const canonicalPath = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
    const metadata = readPlanMetadata(this.artifactRoot, run.work_item_id);

    let content: string;
    let source: "canonical_ready" | "carried_forward" | "synthesized";

    if (metadata?.state === "ready") {
      // Step 5 happy path: an approved plan must have a canonical scratchpad.
      if (!existsSync(canonicalPath)) {
        throw new BadRequestException(
          `ready_plan_scratchpad_missing: work item ${run.work_item_id} is marked ready ` +
            `but canonical scratchpad is missing at ${canonicalPath}`,
        );
      }
      content = readFileSync(canonicalPath, "utf8");
      source = "canonical_ready";
    } else if (existsSync(canonicalPath)) {
      // Legacy / fallback: canonical exists but plan is not in `ready` state.
      // Carry the existing plan forward — edits from prior runs survive.
      content = readFileSync(canonicalPath, "utf8");
      source = "carried_forward";
    } else {
      // Fallback: first run for this work item, no canonical exists.
      // Generate a skeleton and persist to canonical.
      content = this.buildScratchpad(run, node);
      writeFileSync(canonicalPath, content, "utf8");
      source = "synthesized";
    }

    const slug = workItemSlug(run.work_item_id);
    const worktreeScratchpad = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
    writeFileSync(worktreeScratchpad, content, "utf8");
    return { path: worktreeScratchpad, source };
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

  private persistRun(run: ExecutionRunRecord) {
    mkdirSync(run.artifact_dir, { recursive: true });
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    this.upsertRecentRun(run);
    this.writeMetadata(run);
    this.writeStatus(run);
    this.appendEvent(run, { type: "run_created", status: run.status });
    this.emitRun(run.status === "blocked" ? "execution_result" : "execution_status", run);
  }

  private updateRun(runId: string, patch: Partial<ExecutionRunRecord>): ExecutionRunRecord | null {
    const index = this.recentRuns.findIndex((run) => run.run_id === runId);
    if (index === -1) {
      return null;
    }

    const nextRun: ExecutionRunRecord = {
      ...this.recentRuns[index],
      ...patch,
      updated_at: this.now(),
    };
    this.recentRuns[index] = nextRun;
    this.writeStatus(nextRun);
    this.emitRun(nextRun.status === "completed" || nextRun.status === "error" || nextRun.status === "blocked" ? "execution_result" : "execution_status", nextRun);
    return nextRun;
  }

  private getRun(runId: string): ExecutionRunRecord | null {
    return this.recentRuns.find((run) => run.run_id === runId) ?? null;
  }

  private upsertRecentRun(run: ExecutionRunRecord) {
    const existingIndex = this.recentRuns.findIndex((item) => item.run_id === run.run_id);
    if (existingIndex >= 0) {
      this.recentRuns[existingIndex] = run;
    } else {
      this.recentRuns.unshift(run);
      this.recentRuns.splice(this.recentRunLimit);
    }
  }

  private writeMetadata(run: ExecutionRunRecord) {
    writeFileSync(join(run.artifact_dir, "metadata.json"), JSON.stringify({
      run_id: run.run_id,
      run_type: run.run_type,
      created_at: run.created_at,
      work_item_id: run.work_item_id,
      work_item_name: run.work_item_name,
      repo: run.repo,
      issue_url: run.issue_url,
      branch: run.branch,
      base_ref: run.base_ref,
      worktree_path: run.worktree_path,
      artifact_dir: run.artifact_dir,
    }, null, 2), "utf8");
  }

  private writeStatus(run: ExecutionRunRecord) {
    writeFileSync(join(run.artifact_dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
  }

  private writeSummary(run: ExecutionRunRecord, node?: ExecutionDispatchNodePreview) {
    const lines = [
      `# Execution run ${run.run_id}`,
      "",
      `- Work item: ${run.work_item_id} — ${run.work_item_name}`,
      `- Status: ${run.status}`,
      `- Branch: ${run.branch}`,
      `- Base ref: ${run.base_ref}`,
      `- Worktree: ${run.worktree_path}`,
      `- Artifact dir: ${run.artifact_dir}`,
      `- Created: ${run.created_at}`,
      `- Updated: ${run.updated_at}`,
      ...(run.started_at ? [`- Started: ${run.started_at}`] : []),
      ...(run.completed_at ? [`- Completed: ${run.completed_at}`] : []),
      ...(run.pull_request ? [`- Pull request: ${run.pull_request.url}`] : []),
      "",
      "## Safety checks",
      ...run.safety_checks.map((check) => `- [${check.status}] ${check.code}: ${check.message}`),
      "",
      ...(node ? ["## Dispatch scope", ...(node.files_owned.length ? ["Owned files:", ...node.files_owned.map((path) => `- ${path}`)] : ["Owned files: (none predicted)"]), ""] : []),
      "## Result",
      run.result_summary ?? run.progress_message ?? "No summary available.",
      "",
      ...(run.changed_files?.length ? ["## Changed files", ...run.changed_files.map((path) => `- ${path}`), ""] : []),
      ...(run.pull_request ? [
        "## Pull request",
        `- Number: ${run.pull_request.number}`,
        `- URL: ${run.pull_request.url}`,
        `- Draft: ${run.pull_request.is_draft ? "yes" : "no"}`,
        `- Base: ${run.pull_request.base_ref}`,
        `- Head: ${run.pull_request.head_ref}`,
        "",
      ] : []),
    ];

    writeFileSync(join(run.artifact_dir, "summary.md"), lines.join("\n"), "utf8");
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

  private appendEvent(run: ExecutionRunRecord, payload: Record<string, unknown>) {
    appendFileSync(join(run.artifact_dir, "events.jsonl"), `${JSON.stringify({ timestamp: this.now(), run_id: run.run_id, ...payload })}\n`, "utf8");
  }

  private emitRun(eventType: "execution_status" | "execution_result", run: ExecutionRunRecord) {
    const envelope = {
      event_id: `evt_${++this.eventCounter}`,
      stream_id: this.streamId,
      timestamp: this.now(),
      event_type: eventType,
      session_id: run.run_id,
      turn_id: null,
      payload: { run } satisfies ExecutionStatusEvent,
    };

    this.eventSubject.next({
      type: envelope.event_type,
      data: JSON.stringify(envelope),
      id: envelope.event_id,
    });
  }

  private runGit(args: string[], options: { allowFailure?: boolean } = {}): string {
    return this.runCommand("git", args, { cwd: process.cwd(), allowFailure: options.allowFailure });
  }

  private runGitIn(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): string {
    return this.runCommand("git", args, { cwd, allowFailure: options.allowFailure });
  }

  private runGhIn(cwd: string, args: string[], stdin?: string): string {
    return this.runCommand("gh", args, { cwd, stdin });
  }

  private runCommand(command: string, args: string[], options: { cwd: string; stdin?: string; allowFailure?: boolean }): string {
    try {
      return execFileSync(command, args, {
        cwd: options.cwd,
        input: options.stdin,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      if (options.allowFailure) {
        return "";
      }
      throw error;
    }
  }

  private listChangedFiles(worktreePath: string): string[] {
    const output = execFileSync("git", ["status", "--short"], { cwd: worktreePath, encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => this.parseChangedFilePath(line))
      .filter((path): path is string => Boolean(path));
  }

  private parseChangedFilePath(line: string): string | null {
    return parseChangedFilePath(line);
  }

  private countCommitsAhead(worktreePath: string, baseRef: string, branch: string): number {
    const output = this.runGitIn(worktreePath, ["rev-list", "--count", `${baseRef}..${branch}`], { allowFailure: true }).trim();
    const parsed = Number(output);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private readPullRequest(worktreePath: string, fallbackTitle: string, body: string): ExecutionPullRequestRecord {
    const raw = this.runGhIn(worktreePath, ["pr", "view", "--json", "number,url,title,body,baseRefName,headRefName,isDraft"]);
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
    const status = this.runGitIn(run.worktree_path, ["status", "--porcelain"], { allowFailure: true }).trim();
    if (!status) {
      return; // working tree is clean, nothing to commit
    }

    this.logger.log(`Auto-staging and committing changes in ${run.worktree_path}`);
    this.runGitIn(run.worktree_path, ["add", "-A"]);

    // ADR 014 step 6: hard guard against committing `SCRATCHPAD_*.md`.
    // Replaces the silent `.gitignore` trick — disobedience is now visible.
    const stagedViolations = this.findStagedScratchpadViolations(run.worktree_path);
    if (stagedViolations.length > 0) {
      this.appendEvent(run, {
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
    this.runGitIn(run.worktree_path, ["commit", "-m", message]);

    // Refresh changed files after commit
    const changedFiles = this.listChangedFiles(run.worktree_path);
    if (changedFiles.length > 0) {
      this.updateRun(run.run_id, { changed_files: changedFiles });
    }
  }

  /**
   * ADR 014 step 6: detect `SCRATCHPAD_*.md` files in the git index.
   *
   * Basename match at any path depth. Returns an empty array when the
   * index is clean. Callers use the list both for the rejection error
   * message and for the `scratchpad_commit_blocked` event payload.
   */
  private findStagedScratchpadViolations(worktreePath: string): string[] {
    const output = this.runGitIn(worktreePath, ["diff", "--cached", "--name-only"], { allowFailure: true });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && this.isScratchpadPath(line));
  }

  /**
   * ADR 014 step 6: detect `SCRATCHPAD_*.md` files introduced by this
   * branch relative to its base ref.
   *
   * Uses three-dot `$base...HEAD` (merge-base relative) so files that
   * changed on the base branch are not spuriously flagged. This matches
   * what GitHub shows in a pull-request diff.
   */
  private findCommittedScratchpadViolations(worktreePath: string, baseRef: string): string[] {
    const output = this.runGitIn(worktreePath, ["diff", "--name-only", `${baseRef}...HEAD`], { allowFailure: true });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && this.isScratchpadPath(line));
  }

  /** Basename match for `SCRATCHPAD_*.md` at any path depth. */
  private isScratchpadPath(path: string): boolean {
    return /(?:^|\/)SCRATCHPAD_[^/]*\.md$/.test(path);
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

  private markWorkItemInProgressOnLaunch(workItem: WorkItemRecord): { workItem: WorkItemRecord; transitioned: boolean } {
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

    return {
      workItem: this.workItemsService.update(workItem.id, { state: "in_progress" }),
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
  transitionInProgressToReady(workItemId: string): WorkItemRecord {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "in_progress") {
      throw new BadRequestException(
        `Cannot transition ${workItemId} from ${workItem.state} to ready (requires in_progress)`,
      );
    }
    return this.workItemsService.update(workItemId, { state: "ready" });
  }

  /**
   * Transition a work item from in_progress back to drafting.
   *
   * ADR 014 step 5: mirror of `transitionInProgressToReady` for the "plan
   * needs rework" failure return path. Both transitions remain purely
   * operator-triggered in step 5 — automatic failure classification is
   * deferred to step 7 (run disposition).
   */
  transitionInProgressToDrafting(workItemId: string): WorkItemRecord {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "in_progress") {
      throw new BadRequestException(
        `Cannot transition ${workItemId} from ${workItem.state} to drafting (requires in_progress)`,
      );
    }
    return this.workItemsService.update(workItemId, { state: "drafting" });
  }

  /**
   * ADR 014 step 7: disposition flow for `merged_pr → done`.
   *
   * Close variant — transitions the work item to `done` without creating an
   * archive. Plan dir is left in place at `plans/<slug>/`. Used when the user
   * decides the plan and scratchpad are still useful for reference and doesn't
   * want them swept into `archives/`.
   *
   * Guards (checked in order):
   *   1. Work item must exist and be in `merged_pr` state
   *   2. No run for this work item may be active (`queued | preparing |
   *      disambiguating | running`)
   *
   * Both guards throw `BadRequestException` on failure. The state guard
   * prevents bypassing the state machine (the prior raw-PUT path from the
   * frontend "Close issue" button is the side channel this endpoint replaces).
   * The active-run guard prevents disposing work items that still have live
   * runs — see `assertNoActiveRunForWorkItem` for the session-scope caveat.
   */
  closeMergedPullRequest(workItemId: string): WorkItemRecord {
    this.assertWorkItemInMergedPr(workItemId);
    this.assertNoActiveRunForWorkItem(workItemId);
    return this.workItemsService.update(workItemId, { state: "done" });
  }

  /**
   * ADR 014 step 7: disposition flow for `merged_pr → done` with archival.
   *
   * Archive-and-close variant — moves `plans/<slug>/` to `archives/<slug>/`
   * via `fs.renameSync`, writes the canonical archive path onto the work item,
   * and transitions to `done`. If the plan dir is already gone (e.g. a prior
   * partial archive attempt), the filesystem step is a no-op and the state
   * transition still happens.
   *
   * Guard order matters: state + active-run checks BEFORE touching the
   * filesystem. The filesystem move happens BEFORE the state update so a
   * failed `renameSync` leaves the work item in `merged_pr` (retryable). If
   * the state update fails after a successful move, a retry will find the
   * plan dir already gone, observe the move as a no-op, and complete the
   * state transition cleanly.
   *
   * If `archives/<slug>/` already exists, the move refuses rather than
   * clobbering — operators must manually resolve the collision.
   */
  archiveAndCloseMergedPullRequest(workItemId: string): WorkItemRecord {
    this.assertWorkItemInMergedPr(workItemId);
    this.assertNoActiveRunForWorkItem(workItemId);
    const moveResult = this.movePlanDirToArchives(workItemId);
    return this.workItemsService.update(workItemId, {
      state: "done",
      archive_path: moveResult.archive_path ?? this.workItemsService.get(workItemId).archive_path,
    });
  }

  /**
   * ADR 014 step 7: cancellation path with plan dir archival.
   *
   * Handles the `* → cancelled` human transition. Moves the plan dir into
   * `archives/<slug>/` before updating state (same order-of-operations as
   * archive-and-close). Called by `WorkItemsController.transition` when the
   * target is `cancelled`, analogous to how `in_progress → ready` delegates
   * to `transitionInProgressToReady`.
   *
   * The source-state validity check is already enforced by
   * `isValidHumanTransition` upstream in the controller — this method only
   * guards active runs and performs the move. Source states that reach here:
   * `planned`, `drafting`, `ready`, `in_progress`, `open_pr` (the `cancelled`
   * row in `VALID_HUMAN_TRANSITIONS`).
   */
  cancelWorkItem(workItemId: string): WorkItemRecord {
    this.assertNoActiveRunForWorkItem(workItemId);
    const moveResult = this.movePlanDirToArchives(workItemId);
    return this.workItemsService.update(workItemId, {
      state: "cancelled",
      archive_path: moveResult.archive_path ?? this.workItemsService.get(workItemId).archive_path,
    });
  }

  /**
   * Guard: refuse disposition unless the work item is in `merged_pr`.
   *
   * `workItemsService.get` throws `NotFoundException` if the work item doesn't
   * exist — we let that propagate.
   */
  private assertWorkItemInMergedPr(workItemId: string): WorkItemRecord {
    const workItem = this.workItemsService.get(workItemId);
    if (workItem.state !== "merged_pr") {
      throw new BadRequestException(
        `work_item_not_in_merged_pr: cannot dispose ${workItemId} (state is ${workItem.state}, requires merged_pr)`,
      );
    }
    return workItem;
  }

  /**
   * Guard: refuse plan dir moves and disposition transitions if any run for
   * this work item is currently active.
   *
   * Active set: `queued | preparing | disambiguating | running`. These are
   * the statuses in `ExecutionRunStatus` that indicate the run has not yet
   * finished (successfully or otherwise).
   *
   * Limitation: `listRecentRuns` reads from the in-memory `recentRuns` array
   * capped at 16 entries. On server restart this array is empty, so a
   * previously-active run is undetectable by this guard. This is acceptable
   * for ADR 014 V1 because disposition requires `merged_pr`, which requires
   * the run to have reached `open_pr` successfully — meaning any run this
   * guard would flag is effectively "stuck but shouldn't be blocking
   * disposition anyway". If a run is genuinely in progress when the server
   * restarts and the operator immediately calls disposition, they'll get
   * a silent pass. Document the restart gap and move on.
   */
  private assertNoActiveRunForWorkItem(workItemId: string): void {
    const activeStatuses = ["queued", "preparing", "disambiguating", "running"] as const;
    const activeRun = this.listRecentRuns().find(
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

  /**
   * Move the plan dir for a work item into `archives/<slug>/`.
   *
   * Returns `{ moved: true, archive_path }` on a successful move,
   * `{ moved: false, archive_path: null }` if the plan dir didn't exist
   * (warning logged).
   *
   * Throws `BadRequestException("archive_already_exists")` if the
   * destination already exists — we refuse to clobber an existing archive.
   *
   * Called by `archiveAndCloseMergedPullRequest` and (eventually) the
   * `cancelled` disposition path.
   */
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
    return this.listRecentRuns().find((run) => {
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

  private getWorktreePath(branch: string): string {
    const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "execution-run";
    return join(this.worktreeRoot, safeBranch);
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
