import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { workItemSlug } from "../../lib/context-layout.js";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService } from "./scratchpad.service.js";
import { WorktreeService } from "./worktree.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { SettingsService } from "../settings/settings.service.js";
import type { WorkItemRecord } from "../graph/types.js";
import type {
  ActivityLogEntry,
  ActivityLogEntryKind,
  ExecutionDispatchNodePreview,
  ExecutionRunRecord,
  FollowUpMessageDto,
  FollowUpMessageResult,
  RunChatHistory,
  RunChatMessage,
} from "./types.js";
import { classifyExecutionTerminalOutcome } from "./run-outcome.js";

/**
 * Durable coding-session input. The worktree refinement session has already
 * ended before this is invoked, so confirmation can survive a server restart.
 */
export interface RunCodingSessionInput {
  workItem: WorkItemRecord;
  scratchpadPath: string;
  projectContext: string | null;
  /** Prompt that records user responses into the scratchpad before coding. */
  resolutionPrompt?: string | null;
}

export interface RunSessionResult {
  assistantText: string | null;
  reasoningSummary: string | null;
}

/**
 * Phase 4d of the cqrs refactor (#233): owns the pi-coding-agent
 * coding-session lifecycle, the activity-log push
 * helper, the session-event translator, the follow-up turn handler,
 * and (after Tasks 2+3 land) the setup and do-work phase bodies.
 *
 * This service is the single owner of active agent sessions. Human approval
 * is deliberately not represented by an in-memory promise; the durable run
 * record is the handoff between refinement and coding.
 *
 * Injected dependencies:
 *   - RunStore        — run record persistence, activity log push, event emit
 *   - WorktreeService  — runGitIn + listChangedFiles inside executeFollowUpTurn
 *   - ScratchpadService — syncScratchpadToCanonical + emitChecklistIfChanged
 *   - WorkItemsService  — actual_files sync in executeFollowUpTurn
 *   - SettingsService   — getSelectedModel() inside createSession
 *
 * First Phase 4 sub-service with 5 injected siblings. All are already
 * exported from ExecutionModule after 4a/4b/4c — no forwardRef needed.
 */
@Injectable()
export class RunInteractionService {
  private readonly logger = new Logger(RunInteractionService.name);
  /** Active agent sessions keyed by run_id — kept alive while run is active */
  private readonly activeSessions = new Map<string, AgentSession>();

  constructor(
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
    @Inject(ScratchpadService) private readonly scratchpadService: ScratchpadService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
  ) {}

  // ─── Session lifecycle helpers ────────────────────────────────────

  /**
   * Phase 4d (#233): encapsulates the `createAgentSession({...})` block
   * that currently appears verbatim twice in ExecutionService.executeRun
   * and in executeFollowUpTurn. Returns the session + the optional model
   * fallback message so callers can surface the warning through their
   * logger if they like.
   */
  async createSession(run: ExecutionRunRecord): Promise<{
    session: AgentSession;
    modelFallbackMessage: string | null;
  }> {
    const result = await createAgentSession({
      cwd: run.worktree_path,
      sessionManager: SessionManager.inMemory(run.worktree_path),
      tools: ["read", "bash", "edit", "write"],
      model: this.settingsService.getSelectedModel(),
    });
    return {
      session: result.session,
      modelFallbackMessage: result.modelFallbackMessage ?? null,
    };
  }

  registerSession(runId: string, session: AgentSession): void {
    this.activeSessions.set(runId, session);
  }

  disposeSession(runId: string): void {
    this.activeSessions.delete(runId);
  }

  hasActiveSession(runId: string): boolean {
    return this.activeSessions.has(runId);
  }

  getActiveSession(runId: string): AgentSession | undefined {
    return this.activeSessions.get(runId);
  }

  /** Run the confirmed coding phase in a fresh, independently recoverable session. */
  async runCodingSession(
    initialRun: ExecutionRunRecord,
    input: RunCodingSessionInput,
  ): Promise<RunSessionResult> {
    const runId = initialRun.run_id;
    const { session, modelFallbackMessage } = await this.createSession(initialRun);
    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    let run = this.runStore.updateRun(runId, {
      status: "running",
      phase: "coding",
      started_at: initialRun.started_at ?? this.now(),
      session_id: session.sessionId,
      progress_message: "Execution confirmed — coding phase started.",
    });
    if (!run) {
      session.dispose();
      throw new Error(`runCodingSession: run record disappeared for ${runId}`);
    }
    this.pushActivity(run.run_id, "status_change", "Coding agent session started.");
    this.runStore.appendEvent(run, { type: "coding_session_started", session_id: session.sessionId });
    this.runStore.emitRun("execution_status", run);

    this.activeSessions.set(run.run_id, session);
    const unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(runId, event);
    });

    let assistantText: string | null = null;
    try {
      if (input.resolutionPrompt) {
        await session.prompt(input.resolutionPrompt);
        this.scratchpadService.syncScratchpadToCanonical(run);
        this.scratchpadService.emitChecklistIfChanged(run);
      }
      await session.prompt(this.buildDoWorkPrompt(run, undefined, input.workItem, input.projectContext));
      this.scratchpadService.syncScratchpadToCanonical(run);
      this.scratchpadService.emitChecklistIfChanged(run);
      assistantText = session.getLastAssistantText()?.trim() || null;
    } finally {
      unsubscribe();
      this.activeSessions.delete(run.run_id);
      session.dispose();
    }

    const reasoningSummary = assistantText ? this.extractReasoningSummary(assistantText) : null;
    if (reasoningSummary) {
      this.pushActivity(run.run_id, "reasoning", reasoningSummary);
    }

    return { assistantText, reasoningSummary };
  }

  // ─── Prompt builders (Phase 4e) ───────────────────────────────────

  /**
   * Phase 4e (#234): do-work phase prompt builder lifted from
   * ExecutionService.
   */
  buildDoWorkPrompt(
    run: ExecutionRunRecord,
    node: ExecutionDispatchNodePreview | undefined,
    workItem: WorkItemRecord,
    projectContext: string | null,
  ): string {
    // `node` and `workItem` + `projectContext` are accepted so future
    // iterations of the prompt can reference
    // scope/file ownership without changing the signature. The current body
    // only needs `run`.
    void node;
    void workItem;
    void projectContext;
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

  /**
   * Phase 4e (#234): legacy-compat buildPrompt delegating to
   * buildDoWorkPrompt. Still called from `ExecutionService.launch` to
   * pre-populate the `run.prompt` field before the session runs. Kept
   * public so ExecutionService can reach it via the injected service.
   */
  buildPrompt(workItem: WorkItemRecord, node: ExecutionDispatchNodePreview): string {
    const runPreview = {
      work_item_id: workItem.id,
      work_item_name: workItem.name,
    } as Pick<ExecutionRunRecord, "work_item_id" | "work_item_name"> as ExecutionRunRecord;
    return this.buildDoWorkPrompt(runPreview, node, workItem, null);
  }

  extractPromptWorkItemId(prompt: string): string | null {
    const match = prompt.match(/^# Coding Phase for ([^:\n]+):/m);
    return match?.[1]?.trim() || null;
  }

  buildLaunchPrompt(
    workItem: WorkItemRecord,
    node: ExecutionDispatchNodePreview | null | undefined,
    promptOverride?: string | null,
  ): string {
    const trimmedPrompt = promptOverride?.trim();
    if (trimmedPrompt) {
      const promptWorkItemId = this.extractPromptWorkItemId(trimmedPrompt);
      if (promptWorkItemId && promptWorkItemId !== workItem.id) {
        throw new BadRequestException(
          `Prompt work item id ${promptWorkItemId} does not match launch target ${workItem.id}`,
        );
      }
      return trimmedPrompt;
    }

    return node ? this.buildPrompt(workItem, node) : "";
  }

  // ─── Activity log push + getters ──────────────────────────────────

  pushActivity(runId: string, kind: ActivityLogEntryKind, message: string, detail?: string): void {
    const timestamp = this.now();
    const entry: ActivityLogEntry = { timestamp, kind, message, ...(detail ? { detail } : {}) };
    this.runStore.appendActivityLog(runId, entry);
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

  // ─── Session event translation ────────────────────────────────────

  handleSessionEvent(runId: string, event: AgentSessionEvent): void {
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

  extractTextFromMessage(message: unknown): string | null {
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

  extractReasoningSummary(assistantText: string): string | null {
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

  // ─── Follow-up turn handler ───────────────────────────────────────

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
    if (session && (run.status === "running" || run.status === "preparing")) {
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
          phase: "coding",
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

  private async executeFollowUpTurn(run: ExecutionRunRecord, message: string): Promise<void> {
    const { session, modelFallbackMessage } = await this.createSession(run);

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

    const assistantText = session.getLastAssistantText()?.trim() || null;
    if (assistantText) {
      this.pushActivity(run.run_id, "agent_message", assistantText);
    }

    const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path, run.base_ref);
    const actualFilesSync = this.syncActualFiles(run.work_item_id, changedFiles);
    const outcome = classifyExecutionTerminalOutcome({
      phase: "follow_up",
      assistantText,
      changedFiles,
    });

    this.pushActivity(run.run_id, "follow_up", outcome.activityMessage);
    const nextRun = this.runStore.updateRun(run.run_id, {
      status: outcome.status,
      phase: outcome.status === "completed" ? "completed" : "failed",
      completed_at: this.now(),
      progress_message: outcome.progressMessage,
      result_summary: outcome.resultSummary,
      terminal_outcome: outcome.terminalOutcome,
      changed_files: changedFiles,
      errors: outcome.errors,
    });
    if (nextRun) {
      this.runStore.writeSummary(nextRun);
      this.runStore.appendEvent(nextRun, {
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
    }
  }

  /**
   * Duplicated from ExecutionService per Phase 3/4 trivial-helper
   * convention. Follow-up turns update the work item's actual_files
   * on completion; failures are logged and swallowed so the turn can
   * still mark the run complete.
   */
  private syncActualFiles(
    workItemId: string,
    changedFiles: string[],
  ): { ok: true; actual_files: string[] } | { ok: false; message: string } {
    try {
      const actualFiles = [...new Set(changedFiles.filter(Boolean))].sort();
      this.workItemsService.update(workItemId, { actual_files: actualFiles });
      return { ok: true, actual_files: actualFiles };
    } catch (error) {
      this.logger.warn(`Failed to sync actual_files for ${workItemId}: ${this.getErrorMessage(error)}`);
      return { ok: false, message: this.getErrorMessage(error) };
    }
  }

  // ─── Trivial helpers (duplicated from ExecutionService) ───────────

  private now(): string {
    return new Date().toISOString();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isInProgressState(state: WorkItemRecord["state"]): boolean {
    const leaf = state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
    return leaf === "in_progress";
  }
}
