import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService } from "./scratchpad.service.js";
import { WorktreeService } from "./worktree.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { SettingsService } from "../settings/settings.service.js";
import type {
  ActivityLogEntry,
  ActivityLogEntryKind,
  ExecutionRunRecord,
  FollowUpMessageDto,
  FollowUpMessageResult,
  ResolveDisambiguationDto,
  ResolveDisambiguationResult,
  RunChatHistory,
  RunChatMessage,
} from "./types.js";

/**
 * Phase 4d of the cqrs refactor (#233): owns the pi-coding-agent
 * session lifecycle, the disambiguation gate, the activity-log push
 * helper, the session-event translator, the follow-up turn handler,
 * and (after Tasks 2+3 land) the setup and do-work phase bodies.
 *
 * This service is the single owner of `activeSessions` +
 * `disambiguationGates`. `ExecutionService.executeRun` calls into
 * this service via the helper methods below and never touches either
 * map directly.
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
  /** Disambiguation gate resolvers — calling the stored function unblocks the coding phase */
  private readonly disambiguationGates = new Map<string, { resolve: (additionalContext?: string) => void }>();

  constructor(
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
    @Inject(ScratchpadService) private readonly scratchpadService: ScratchpadService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
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
      tools: createCodingTools(run.worktree_path),
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

  /**
   * Phase 4d (#233): wraps the inline gate-await Promise pattern that
   * executeRun uses at the setup-phase approval boundary. Registers a
   * resolver in `disambiguationGates`; `resolveDisambiguation` below
   * fires it. Caller awaits the returned Promise.
   */
  awaitDisambiguationGate(runId: string): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this.disambiguationGates.set(runId, { resolve });
    });
  }

  clearDisambiguationGate(runId: string): void {
    this.disambiguationGates.delete(runId);
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

  // ─── Disambiguation gate resolution ───────────────────────────────

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
}
