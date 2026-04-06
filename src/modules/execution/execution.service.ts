import { BadRequestException, Inject, Injectable, Logger, MessageEvent } from "@nestjs/common";
import { createAgentSession, createCodingTools, SessionManager, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Observable, Subject } from "rxjs";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { getDefaultWorkingBranch, listDefaultWorkingBranches } from "./default-working-branches.js";
import { GitHubService } from "../github/github.service.js";
import { GraphService } from "../graph/graph.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord } from "../graph/types.js";
import type {
  ActivityLogEntry,
  ActivityLogEntryKind,
  CreateExecutionPullRequestDto,
  CreateExecutionPullRequestResult,
  ExecutionDispatchGroupPreview,
  ExecutionDispatchNodePreview,
  ExecutionDispatchPreview,
  ExecutionPullRequestRecord,
  ExecutionRunRecord,
  ExecutionSafetyCheck,
  ExecutionStatusEvent,
  LaunchExecutionRunDto,
  LaunchExecutionRunResult,
  CleanupWorktreeDto,
  CleanupWorktreeResult,
  SyncMergedExecutionDto,
  SyncMergedExecutionResult,
} from "./types.js";

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly streamId = "execution-runs";
  private readonly eventSubject = new Subject<MessageEvent>();
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  private readonly worktreeRoot = join(this.artifactRoot, "worktrees");
  private readonly recentRuns: ExecutionRunRecord[] = [];
  private readonly recentRunLimit = 16;
  private readonly activityLogLimit = 50;
  private eventCounter = 0;

  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
  ) {}

  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.eventSubject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  listRecentRuns(): ExecutionRunRecord[] {
    return [...this.recentRuns].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getPreview(repo?: string): ExecutionDispatchPreview {
    const plan = this.graphService.getPlan(repo);
    const groups: ExecutionDispatchGroupPreview[] = plan.parallel_groups.map((group, index) => ({
      group_id: `group_${index + 1}`,
      repo: group.repo,
      merge_order: group.merge_order,
      nodes: group.nodes.map((node) => {
        const workItem = this.safeGetWorkItem(node.id);
        const worktreePath = this.getWorktreePath(node.branch);
        const defaultBaseRef = getDefaultWorkingBranch(workItem?.repo ?? (group.repo === "unknown" ? null : group.repo));
        const safetyChecks = this.evaluateSafety(node.branch, worktreePath, defaultBaseRef);
        return {
          id: node.id,
          name: node.name,
          repo: group.repo === "unknown" ? null : group.repo,
          branch: node.branch,
          issue_url: node.issue_url,
          scope_hint: workItem?.scope_hint ?? null,
          default_base_ref: defaultBaseRef,
          files_owned: node.files_owned,
          files_shared: node.files_shared,
          files_forbidden: node.files_forbidden,
          worktree_path: worktreePath,
          safety_checks: safetyChecks,
          can_launch: !safetyChecks.some((check) => check.status === "fail"),
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

  async launch(input: LaunchExecutionRunDto): Promise<LaunchExecutionRunResult> {
    const workItemId = input.work_item_id?.trim();
    if (!workItemId) {
      throw new BadRequestException("work_item_id is required");
    }

    const preview = this.getPreview();
    const node = preview.groups.flatMap((group) => group.nodes).find((candidate) => candidate.id === workItemId);
    const workItem = this.workItemsService.get(workItemId);
    const baseRef = input.base_ref?.trim() || getDefaultWorkingBranch(workItem.repo);

    if (!node) {
      const run = this.createRunRecord({
        workItem,
        branch: workItem.branch ?? `${workItem.id}-branch`,
        baseRef,
        worktreePath: this.getWorktreePath(workItem.branch ?? `${workItem.id}-branch`),
        safetyChecks: [{ code: "not_dispatchable", status: "fail", message: "Work item is not currently dispatchable from the frontier." }],
        prompt: input.prompt?.trim() || "",
        status: "blocked",
        resultSummary: "Launch blocked because the work item is not currently dispatchable.",
        errors: [{ code: "not_dispatchable", message: "Work item is not currently dispatchable from the frontier." }],
      });
      this.persistRun(run);
      this.emitRun("execution_result", run);
      return { accepted: false, run };
    }

    const safetyChecks = this.evaluateSafety(node.branch, node.worktree_path, baseRef);
    if (safetyChecks.some((check) => check.status === "fail")) {
      const run = this.createRunRecord({
        workItem,
        branch: node.branch,
        baseRef,
        worktreePath: node.worktree_path,
        safetyChecks,
        prompt: input.prompt?.trim() || this.buildPrompt(workItem, node),
        status: "blocked",
        resultSummary: "Launch blocked by execution safety checks.",
        errors: safetyChecks.filter((check) => check.status === "fail").map((check) => ({ code: check.code, message: check.message })),
      });
      this.persistRun(run);
      this.emitRun("execution_result", run);
      return { accepted: false, run };
    }

    const run = this.createRunRecord({
      workItem,
      branch: node.branch,
      baseRef,
      worktreePath: node.worktree_path,
      safetyChecks,
      prompt: input.prompt?.trim() || this.buildPrompt(workItem, node),
      status: "queued",
      resultSummary: undefined,
      errors: [],
    });

    this.persistRun(run);
    this.pushActivity(run.run_id, "status_change", "Execution run queued.");
    void this.executeRun(run, node).catch((error) => {
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

    // Update work item: set state to in_progress and store PR metadata
    try {
      const existingMeta = workItem.meta ?? {};
      this.workItemsService.update(run.work_item_id, {
        state: "in_progress",
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

    this.workItemsService.update(workItem.id, {
      state: "done",
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

    if (run.status === "running" || run.status === "preparing") {
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

  private async executeRun(initialRun: ExecutionRunRecord, node: ExecutionDispatchNodePreview) {
    let run = this.updateRun(initialRun.run_id, {
      status: "preparing",
      progress_message: "Creating isolated git worktree.",
    });
    if (!run) {
      return;
    }
    this.appendEvent(run, { type: "run_preparing" });

    this.runGit(["worktree", "add", run.worktree_path, "-b", run.branch, run.base_ref]);
    this.pushActivity(run.run_id, "status_change", `Worktree created at ${run.worktree_path}`, `Branch: ${run.branch}, Base: ${run.base_ref}`);
    this.appendEvent(run, { type: "worktree_created", worktree_path: run.worktree_path, branch: run.branch, base_ref: run.base_ref });

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
      progress_message: "Execution agent running in isolated worktree.",
    })!;
    this.pushActivity(run.run_id, "status_change", "Agent session started.");
    this.appendEvent(run, { type: "session_started", session_id: session.sessionId });

    const runId = run.run_id;
    const unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(runId, event);
    });

    try {
      await session.prompt(run.prompt);
    } finally {
      unsubscribe();
      session.dispose();
    }

    const assistantText = session.getLastAssistantText()?.trim() ?? "Execution run completed without a terminal summary.";
    // Extract a short reasoning summary from the assistant's final text
    const reasoningSummary = this.extractReasoningSummary(assistantText);
    if (reasoningSummary) {
      this.pushActivity(run.run_id, "reasoning", reasoningSummary);
    }
    const changedFiles = this.listChangedFiles(run.worktree_path);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "response.json"), JSON.stringify({ assistant_text: assistantText, changed_files: changedFiles, actual_files_sync: actualFilesSync }, null, 2), "utf8");

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
      return;
    }

    if (event.type === "message_end") {
      this.appendEvent(run, { type: event.type });
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

  private pushActivity(runId: string, kind: ActivityLogEntryKind, message: string, detail?: string) {
    const run = this.getRun(runId);
    if (!run) {
      return;
    }
    const entry: ActivityLogEntry = { timestamp: this.now(), kind, message, ...(detail ? { detail } : {}) };
    run.activity_log.push(entry);
    if (run.activity_log.length > this.activityLogLimit) {
      run.activity_log = run.activity_log.slice(-this.activityLogLimit);
    }
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

  private buildPrompt(workItem: WorkItemRecord, node: ExecutionDispatchNodePreview): string {
    const owned = node.files_owned.length ? node.files_owned.map((path) => `- ${path}`).join("\n") : "- (none predicted)";
    const shared = node.files_shared.length
      ? node.files_shared.map((file) => `- ${file.path} (${file.assessment}/${file.confidence})`).join("\n")
      : "- (none)";
    const forbidden = node.files_forbidden.length ? node.files_forbidden.map((path) => `- ${path}`).join("\n") : "- (none)";

    return [
      `You are executing Studio work item ${workItem.id}: ${workItem.name}.`,
      "You are running inside a dedicated git worktree created by Escapement Studio.",
      "Make concrete implementation progress for this work item while staying inside the predicted scope.",
      "Prefer focused changes over broad refactors.",
      "At the end, summarize what you changed, any tests/run checks you performed, and any remaining blockers.",
      "",
      `Repo: ${workItem.repo ?? "(not set)"}`,
      `Issue URL: ${workItem.issue_url ?? "(not set)"}`,
      `Scope hint: ${workItem.scope_hint ?? "(not set)"}`,
      `Suggested execution branch: ${node.branch}`,
      `Default working base branch: ${node.default_base_ref}`,
      "",
      "Files owned:",
      owned,
      "",
      "Files shared:",
      shared,
      "",
      "Files forbidden:",
      forbidden,
      "",
      "If you must go beyond the predicted scope, explain why in the final summary.",
    ].join("\n");
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
      artifact_dir: join(this.artifactRoot, "runs", runId),
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

    const message = commitMessage?.trim() || this.buildCommitMessage(workItem);
    this.runGitIn(run.worktree_path, ["commit", "-m", message]);

    // Refresh changed files after commit
    const changedFiles = this.listChangedFiles(run.worktree_path);
    if (changedFiles.length > 0) {
      this.updateRun(run.run_id, { changed_files: changedFiles });
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
