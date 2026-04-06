import { BadRequestException, Inject, Injectable, Logger, MessageEvent } from "@nestjs/common";
import { createAgentSession, createCodingTools, SessionManager, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Observable, Subject } from "rxjs";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { GraphService } from "../graph/graph.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord } from "../graph/types.js";
import type {
  ExecutionDispatchGroupPreview,
  ExecutionDispatchNodePreview,
  ExecutionDispatchPreview,
  ExecutionRunRecord,
  ExecutionSafetyCheck,
  ExecutionStatusEvent,
  LaunchExecutionRunDto,
  LaunchExecutionRunResult,
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
  private eventCounter = 0;

  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
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
        const safetyChecks = this.evaluateSafety(node.branch, worktreePath);
        return {
          id: node.id,
          name: node.name,
          repo: group.repo === "unknown" ? null : group.repo,
          branch: node.branch,
          issue_url: node.issue_url,
          scope_hint: workItem?.scope_hint ?? null,
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
      assumptions: plan.assumptions,
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
    const baseRef = input.base_ref?.trim() || "develop";

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
    void this.executeRun(run, node).catch((error) => {
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
    const changedFiles = this.listChangedFiles(run.worktree_path);
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "response.json"), JSON.stringify({ assistant_text: assistantText, changed_files: changedFiles }, null, 2), "utf8");

    run = this.updateRun(initialRun.run_id, {
      status: "completed",
      completed_at: this.now(),
      progress_message: "Execution run completed.",
      result_summary: assistantText,
      changed_files: changedFiles,
    })!;
    this.writeSummary(run, node);
    this.appendEvent(run, { type: "run_completed", changed_files: changedFiles });
    this.emitRun("execution_result", run);
  }

  private handleSessionEvent(runId: string, event: AgentSessionEvent) {
    const run = this.getRun(runId);
    if (!run) {
      return;
    }

    const toolName = "toolName" in event ? event.toolName ?? null : null;
    if (event.type === "tool_execution_start") {
      this.appendEvent(run, { type: event.type, tool_name: toolName });
      this.updateRun(runId, { progress_message: `${toolName ?? "tool"} running…` });
      return;
    }

    if (event.type === "tool_execution_end") {
      this.appendEvent(run, { type: event.type, tool_name: toolName });
      this.updateRun(runId, { progress_message: `${toolName ?? "tool"} finished.` });
      return;
    }

    if (event.type === "message_end") {
      this.appendEvent(run, { type: event.type });
      return;
    }

    if (event.type === "agent_start" || event.type === "turn_start") {
      this.appendEvent(run, { type: event.type });
      this.updateRun(runId, { progress_message: "Execution turn started." });
      return;
    }

    if (event.type === "agent_end" || event.type === "turn_end") {
      this.appendEvent(run, { type: event.type });
      this.updateRun(runId, { progress_message: "Execution turn completed." });
    }
  }

  private evaluateSafety(branch: string, worktreePath: string, baseRef = "develop"): ExecutionSafetyCheck[] {
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
      "",
      "## Safety checks",
      ...run.safety_checks.map((check) => `- [${check.status}] ${check.code}: ${check.message}`),
      "",
      ...(node ? ["## Dispatch scope", ...(node.files_owned.length ? ["Owned files:", ...node.files_owned.map((path) => `- ${path}`)] : ["Owned files: (none predicted)"]), ""] : []),
      "## Result",
      run.result_summary ?? run.progress_message ?? "No summary available.",
      "",
      ...(run.changed_files?.length ? ["## Changed files", ...run.changed_files.map((path) => `- ${path}`), ""] : []),
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
    try {
      return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
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
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
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
