import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { EventBus } from "@nestjs/cqrs";
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
import { RunCompletedEvent } from "./events/run-completed.event.js";
import { PullRequestService } from "./pull-request.service.js";
import { classifyExecutionTerminalOutcome } from "./run-outcome.js";
import { RunInteractionService } from "./run-interaction.service.js";
import { RunRefinementService } from "./run-refinement.service.js";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService } from "./scratchpad.service.js";
import { WorkItemReconcilerService } from "./work-item-reconciler.service.js";
import { WorktreeService } from "./worktree.service.js";
import { GraphService } from "../graph/graph.service.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord, WorkItemState } from "../graph/types.js";
import type {
  ActivityLogEntry,
  ArchivedRunBundle,
  CreateExecutionPullRequestDto,
  CreateExecutionPullRequestResult,
  ExecutionChecklistSnapshot,
  ExecutionDispatchGroupPreview,
  ExecutionDispatchNodePreview,
  ExecutionDispatchPreview,
  ExecutionLaunchEligibility,
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
  SyncMergedExecutionDto,
  SyncMergedExecutionResult,
} from "./types.js";

@Injectable()
export class ExecutionService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);

  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(WorkItemReconcilerService) private readonly workItemReconciler: WorkItemReconcilerService,
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(RunInteractionService) private readonly runInteractionService: RunInteractionService,
    @Inject(RunRefinementService) private readonly runRefinementService: RunRefinementService,
    @Inject(PullRequestService) private readonly pullRequestService: PullRequestService,
    @Inject(ScratchpadService) private readonly scratchpadService: ScratchpadService,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {
    // Phase 4e (#234): the truth refresher callback is registered by
    // PullRequestService in its own constructor. ExecutionService no
    // longer touches `registerPullRequestTruthRefresher`.
  }

  /**
   * Issue #176: at startup, rewrite runs that require a live agent session
   * to `error` (orphaned by server restart), rehydrate
   * `recentRuns` from disk so completed runs survive a restart, and
   * run an initial reconcile pass to populate the derived view.
   * Runs awaiting execution confirmation are deliberately rehydrated intact.
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
      this.repairCommittedFalseNoopRuns();
    } catch (error) {
      this.logger.warn(
        `Failed to hydrate recentRuns from disk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
        prompt: this.runInteractionService.buildLaunchPrompt(workItem, node, input.prompt),
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
      prompt: this.runInteractionService.buildLaunchPrompt(launchState.workItem, node, input.prompt),
      status: "queued",
      resultSummary: undefined,
      errors: [],
    });

    this.runStore.persistRun(run);
    // ADR 014 step 5: record the run ID on the plan so the plan metadata
    // knows about every attempt (including blocked/failed ones). Non-fatal.
    this.appendRunIdToPlanMetadata(run.work_item_id, run.run_id);
    this.runInteractionService.pushActivity(
      run.run_id,
      "status_change",
      launchState.transitioned
        ? "Execution run queued. Work item state updated to in_progress."
        : "Execution run queued.",
    );
    void this.executeRun(run, node).catch((error) => this.failRun(run.run_id, error));

    return { accepted: true, run };
  }

  async createPullRequest(input: CreateExecutionPullRequestDto): Promise<CreateExecutionPullRequestResult> {
    return this.pullRequestService.createPullRequest(input);
  }

  async syncMergedPullRequest(input: SyncMergedExecutionDto): Promise<SyncMergedExecutionResult> {
    // Phase 4e (#234): PullRequestService returns the envelope without
    // dispatch_preview. ExecutionService composes the preview here
    // using its existing getPreview helper so PullRequestService stays
    // free of a GraphService injection.
    const result = await this.pullRequestService.syncMergedPullRequest(input);
    // Re-fetch repo to pass into getPreview — the result's work_item
    // envelope doesn't include repo, but the input has the work_item_id
    // and the work item lookup is an O(1) Map.get.
    const workItem = this.workItemsService.get(result.work_item.id);
    return {
      ...result,
      dispatch_preview: this.getPreview(workItem.repo ?? undefined),
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
      if (
        run.status !== "running"
        && run.status !== "preparing"
        && run.status !== "queued"
        && run.status !== "disambiguating"
      ) {
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
    if (run.status !== "disambiguating" || run.phase !== "awaiting_confirmation") {
      return {
        resolved: false,
        run_id: runId,
        error: `Run is in status "${run.status}" / phase "${run.phase ?? "unknown"}"; expected execution confirmation.`,
      };
    }
    if (!run.refinement || run.refinement.status !== "awaiting_confirmation") {
      return {
        resolved: false,
        run_id: runId,
        error: "Run has no persisted refinement result to confirm.",
      };
    }

    const responseById = new Map<string, string>();
    for (const response of input.responses ?? []) {
      const itemId = response.item_id?.trim();
      const text = response.response?.trim();
      if (itemId && text) responseById.set(itemId, text);
    }
    const knownIds = new Set(run.refinement.items.map((item) => item.id));
    const unknownIds = [...responseById.keys()].filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      return {
        resolved: false,
        run_id: runId,
        error: `Unknown refinement item response(s): ${unknownIds.join(", ")}`,
      };
    }

    const items = run.refinement.items.map((item) => ({
      ...item,
      response: responseById.get(item.id) ?? item.response ?? null,
    }));
    const unresolved = items.filter((item) => !item.response?.trim());
    if (unresolved.length > 0 && input.confirm_unresolved !== true) {
      return {
        resolved: false,
        run_id: runId,
        error: `Answer all refinement items or explicitly confirm ${unresolved.length} unresolved item(s).`,
      };
    }

    const confirmedAt = this.now();
    const confirmedRun = this.runStore.updateRun(runId, {
      status: "queued",
      phase: "coding",
      progress_message: "Execution confirmed — coding session queued.",
      refinement: {
        ...run.refinement,
        status: "confirmed",
        items,
        confirmed_at: confirmedAt,
        additional_context: input.additional_context?.trim() || null,
        confirmed_with_unresolved: unresolved.length > 0,
      },
    });
    if (!confirmedRun) {
      throw new BadRequestException(`Execution run disappeared while confirming: ${runId}`);
    }
    this.runInteractionService.pushActivity(
      runId,
      "status_change",
      unresolved.length > 0
        ? `Execution confirmed with ${unresolved.length} unresolved item(s) — coding queued.`
        : "Execution plan confirmed — coding queued.",
    );
    this.runStore.appendEvent(confirmedRun, {
      type: "execution_confirmed",
      response_count: items.length - unresolved.length,
      unresolved_count: unresolved.length,
    });
    this.runStore.emitRun("execution_status", confirmedRun);
    void this.continueRunAfterConfirmation(confirmedRun).catch((error) => this.failRun(runId, error));
    return { resolved: true, run_id: runId, run: confirmedRun };
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

  private async executeRun(initialRun: ExecutionRunRecord, node: ExecutionDispatchNodePreview) {
    let run = this.runStore.updateRun(initialRun.run_id, {
      status: "preparing",
      phase: "preparing",
      progress_message: "Creating isolated git worktree.",
    });
    if (!run) {
      return;
    }
    this.runStore.appendEvent(run, { type: "run_preparing" });
    this.runStore.emitRun("execution_status", run);

    // --- Create worktree ---
    this.worktreeService.createWorktree(run.branch, run.base_ref, run.worktree_path);
    this.runInteractionService.pushActivity(run.run_id, "status_change", `Worktree created at ${run.worktree_path}`, `Branch: ${run.branch}, Base: ${run.base_ref}`);
    this.runStore.appendEvent(run, { type: "worktree_created", worktree_path: run.worktree_path, branch: run.branch, base_ref: run.base_ref });

    // --- Install dependencies in worktree ---
    // Emit a status event before the potentially slow install so the UI shows progress.
    this.runStore.emitRun("execution_status", run);
    const runIdForActivity = run.run_id;
    this.worktreeService.installDependencies(run.worktree_path, (kind, message) => {
      this.runInteractionService.pushActivity(runIdForActivity, kind, message);
    });

    // --- Gather context ---
    const workItem = this.workItemsService.get(run.work_item_id);
    const issueBody = fetchIssueBody(workItem.repo, workItem.issue_number);
    const projectContext = this.readProjectContext(run.worktree_path);
    this.runInteractionService.pushActivity(run.run_id, "status_change", `Context gathered: issue body ${issueBody ? "found" : "not found"}, project conventions ${projectContext ? "found" : "not found"}`);

    // --- Write initial scratchpad ---
    // Strict plan/run boundary: launch only consumes an approved canonical
    // scratchpad. Synthesis belongs to plan preparation, never execution.
    const scratchpadResult = this.scratchpadService.writeScratchpad(run, node, { requireApproved: true });
    const scratchpadPath = scratchpadResult.path;
    this.runInteractionService.pushActivity(
      run.run_id,
      "status_change",
      `Approved plan loaded from canonical scratchpad at ${scratchpadPath}`,
    );
    this.runStore.appendEvent(run, { type: "scratchpad_written", path: scratchpadPath });
    this.scratchpadService.emitChecklistIfChanged(run);

    // The refinement session ends before the durable human gate. Coding is
    // started later by resolveDisambiguation in a fresh agent session.
    await this.runRefinementService.refine(run, {
      node,
      workItem,
      scratchpadPath,
      issueBody,
      projectContext,
    });
  }

  private async continueRunAfterConfirmation(initialRun: ExecutionRunRecord): Promise<void> {
    const run = this.runStore.getRun(initialRun.run_id) ?? initialRun;
    if (!existsSync(run.worktree_path)) {
      throw new Error(`Execution worktree is missing: ${run.worktree_path}`);
    }
    const workItem = this.workItemsService.get(run.work_item_id);
    const scratchpadPath = join(
      run.worktree_path,
      `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md`,
    );
    if (!existsSync(scratchpadPath)) {
      throw new Error(`Refined execution scratchpad is missing: ${scratchpadPath}`);
    }
    const projectContext = this.readProjectContext(run.worktree_path);
    const resolutionPrompt = this.runRefinementService.buildResolutionPrompt(run);
    const { assistantText } = await this.runInteractionService.runCodingSession(run, {
      workItem,
      scratchpadPath,
      projectContext,
      resolutionPrompt,
    });
    await this.completeCodingRun(run.run_id, assistantText);
  }

  private async completeCodingRun(runId: string, assistantText: string | null): Promise<void> {
    let run = this.runStore.getRun(runId);
    if (!run) return;
    const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path, run.base_ref);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "response.json"), JSON.stringify({ assistant_text: assistantText, changed_files: changedFiles, actual_files_sync: actualFilesSync }, null, 2), "utf8");

    // The canonical scratchpad at plans/<slug>/SCRATCHPAD_<slug>.md is the
    // post-run snapshot — synced above at each phase boundary. No separate
    // scratchpad-final.md is written under the run artifact dir anymore.

    const outcome = classifyExecutionTerminalOutcome({
      phase: "initial",
      assistantText,
      changedFiles,
    });
    const resultSummary = actualFilesSync.ok
      ? `${outcome.resultSummary}\n\nactual_files synced: ${changedFiles.length} file(s).`
      : outcome.resultSummary;
    const progressMessage = actualFilesSync.ok && outcome.status === "completed"
      ? "Execution run completed. actual_files updated on the work item."
      : outcome.progressMessage;

    this.runInteractionService.pushActivity(run.run_id, "status_change", outcome.activityMessage);
    run = this.runStore.updateRun(runId, {
      status: outcome.status,
      phase: outcome.status === "completed" ? "completed" : "failed",
      completed_at: this.now(),
      progress_message: progressMessage,
      result_summary: resultSummary,
      terminal_outcome: outcome.terminalOutcome,
      changed_files: changedFiles,
      errors: outcome.errors,
    })!;
    this.runStore.writeSummary(run);
    this.runStore.appendEvent(run, {
      type: outcome.eventType,
      changed_files: changedFiles,
      actual_files_sync: actualFilesSync,
      terminal_outcome: outcome.terminalOutcome,
    });

    if (outcome.dispatchRunError) {
      const workItem = this.workItemsService.get(run.work_item_id);
      if (this.isInProgressState(workItem.state)) {
        await this.hsmService.dispatch(run.work_item_id, {
          type: "run.error",
          run_id: run.run_id,
          reason: outcome.terminalOutcome.detail,
        });
      }
    }

    if (outcome.publishCompletedEvent) {
      // Phase 5 (#225): publish RunCompletedEvent so future consumers
      // (drift reports, notifications, etc.) can react without editing
      // executeRun. No subscribers land in Phase 5. `pullRequest` is
      // null at this point because PR creation is a separate later
      // step — most freshly-completed runs don't have a PR yet.
      this.eventBus.publish(
        new RunCompletedEvent(
          run.run_id,
          run.work_item_id,
          changedFiles,
          assistantText ?? outcome.resultSummary,
          run.pull_request ?? null,
        ),
      );
    }
  }

  /**
   * Repair terminal records written by older Studio builds that only looked
   * at `git status` when deciding whether an agent changed files. A clean
   * worktree with commits ahead of the base was consequently persisted as a
   * suspect no-op. The branch diff is authoritative enough to recover those
   * records on startup without re-running the coding agent.
   */
  private repairCommittedFalseNoopRuns(): void {
    for (const run of this.runStore.listRecentRuns()) {
      if (
        run.status !== "error" ||
        !["no_changes", "no_changes_and_missing_summary"].includes(run.terminal_outcome?.code ?? "") ||
        !existsSync(run.worktree_path)
      ) {
        continue;
      }

      const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path, run.base_ref);
      if (changedFiles.length === 0) continue;

      const assistantText = this.readRunAssistantText(run);
      const outcome = classifyExecutionTerminalOutcome({
        phase: "initial",
        assistantText,
        changedFiles,
      });
      const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);
      mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
      writeFileSync(
        join(run.artifact_dir, "outputs", "response.json"),
        JSON.stringify({ assistant_text: assistantText, changed_files: changedFiles, actual_files_sync: actualFilesSync }, null, 2),
        "utf8",
      );
      const resultSummary = actualFilesSync.ok
        ? `${outcome.resultSummary}\n\nactual_files synced: ${changedFiles.length} file(s).`
        : outcome.resultSummary;
      const progressMessage = actualFilesSync.ok && outcome.status === "completed"
        ? "Execution run completed. Committed branch changes recovered and actual_files updated."
        : outcome.progressMessage;

      this.runInteractionService.pushActivity(
        run.run_id,
        "status_change",
        `Recovered ${changedFiles.length} committed file change(s) that the original completion check missed.`,
      );
      const repairedRun = this.runStore.updateRun(run.run_id, {
        status: outcome.status,
        phase: outcome.status === "completed" ? "completed" : "failed",
        progress_message: progressMessage,
        result_summary: resultSummary,
        terminal_outcome: outcome.terminalOutcome,
        changed_files: changedFiles,
        errors: outcome.errors,
      });
      if (!repairedRun) continue;

      this.runStore.writeSummary(repairedRun);
      this.runStore.appendEvent(repairedRun, {
        type: "run_outcome_recovered",
        changed_files: changedFiles,
        actual_files_sync: actualFilesSync,
        terminal_outcome: outcome.terminalOutcome,
      });
    }
  }

  private readRunAssistantText(run: ExecutionRunRecord): string | null {
    try {
      const response = JSON.parse(readFileSync(join(run.artifact_dir, "outputs", "response.json"), "utf8")) as {
        assistant_text?: unknown;
      };
      return typeof response.assistant_text === "string" && response.assistant_text.trim().length > 0
        ? response.assistant_text.trim()
        : null;
    } catch {
      return null;
    }
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    const message = this.getErrorMessage(error);
    this.runInteractionService.pushActivity(runId, "error", `Execution failed: ${message}`);
    const failedRun = this.runStore.updateRun(runId, {
      status: "error",
      phase: "failed",
      completed_at: this.now(),
      progress_message: `Execution failed: ${message}`,
      result_summary: `Execution failed: ${message}`,
      errors: [{ code: "execution_failed", message }],
    });
    if (!failedRun) return;
    this.runStore.writeSummary(failedRun);
    this.runStore.appendEvent(failedRun, { type: "run_failed", error: message });
    this.runStore.emitRun("execution_result", failedRun);
    const workItem = this.workItemsService.get(failedRun.work_item_id);
    const leaf = workItem.state.startsWith("pre_pr.")
      ? workItem.state.slice("pre_pr.".length)
      : workItem.state;
    if (leaf === "in_progress") {
      await this.hsmService.dispatch(failedRun.work_item_id, {
        type: "run.error",
        run_id: failedRun.run_id,
        reason: message,
      });
    }
  }

  getRunActivityLog(runId: string): ActivityLogEntry[] {
    return this.runInteractionService.getRunActivityLog(runId);
  }

  getRunChatHistory(runId: string): RunChatHistory {
    return this.runInteractionService.getRunChatHistory(runId);
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
    return this.runInteractionService.sendFollowUp(input);
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
   * A work item is launchable only when its plan was explicitly approved and
   * the HSM leaf state is `ready`. Plan preparation and execution are separate
   * durable phases; execution never synthesizes a fallback plan.
   */
  private isLaunchableState(state: WorkItemState): boolean {
    const leaf = state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
    return leaf === "ready";
  }

  private isInProgressState(state: WorkItemState): boolean {
    const leaf = state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
    return leaf === "in_progress";
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
      phase: input.status === "queued"
        ? "queued"
        : input.status === "blocked" ? "blocked" : undefined,
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
    // `PlansService.approve`.
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
