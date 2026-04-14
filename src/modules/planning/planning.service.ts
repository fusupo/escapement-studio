import { BadRequestException, Inject, Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Observable, Subject } from "rxjs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../../config.js";
import { GitHubService } from "../github/github.service.js";
import { GraphService } from "../graph/graph.service.js";
import { GraphWriterService } from "../graph/graph-writer.service.js";
import type {
  CreateEdgeDto,
  CreateWorkItemDto,
  DeleteEdgeMutation,
  DeleteWorkItemMutation,
  EdgeRel,
  GraphMutation,
  UpdateWorkItemDto,
} from "../graph/types.js";
import { ContextService } from "./context.service.js";
import { MemoryService } from "./memory.service.js";
import { ProposalStateService } from "./proposal-state.service.js";
import { SubAgentService } from "./sub-agent.service.js";
import { DriftReportService } from "../drift-report/drift-report.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { createPlanningTools } from "./tools/tool-registry.js";
import type { PlanningToolDeps } from "./tools/types.js";
import type {
  ApproveGitHubSyncDto,
  ApproveMutationProposalDto,
  ApprovePlanningMemoryChangeDto,
  CreateEdgePayload,
  CreateWorkItemPayload,
  GitHubSyncResult,
  PlanningGraphCommitResult,
  PlanningMemoryWriteResult,
  PlanningMutationProposalMutation,
  PlanningSessionSnapshot,
  PlanningSessionTranscriptEntry,
  SendAgentMessageDto,
  SendAgentMessageResult,
  StudioSseEnvelope,
  UpdateWorkItemPayload,
} from "./types.js";

@Injectable()
export class PlanningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlanningService.name);
  private readonly streamId = "planning-root";
  private readonly eventSubject = new Subject<MessageEvent>();
  private readonly sessionDir = resolve(process.cwd(), getConfig().planningSessionDir);

  private session?: AgentSession;
  private sessionPromise?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private eventCounter = 0;
  private turnCounter = 0;
  private currentTurnId: string | null = null;

  constructor(
    @Inject(ContextService) private readonly contextService: ContextService,
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
    @Inject(MemoryService) private readonly memoryService: MemoryService,
    @Inject(SubAgentService) private readonly subAgentService: SubAgentService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
    @Inject(DriftReportService) private readonly driftReportService: DriftReportService,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
    @Inject(ProposalStateService) private readonly proposalState: ProposalStateService,
  ) {}

  async onModuleInit() {
    await this.ensureSession();
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    this.session?.dispose();
    this.eventSubject.complete();
  }

  stream(): Observable<MessageEvent> {
    void this.ensureSession();

    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.eventSubject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  async getSessionSnapshot(): Promise<PlanningSessionSnapshot> {
    const session = await this.ensureSession();

    return {
      session_id: session.sessionId,
      session_file: session.sessionFile,
      is_streaming: session.isStreaming,
      messages: this.projectSessionEntries(session.sessionManager.getEntries()),
      active_proposal: this.proposalState.getActiveProposal(),
      last_commit_result: this.proposalState.getLastCommitResult(),
      active_memory_change: this.proposalState.getActiveMemoryChange(),
      last_memory_write_result: this.proposalState.getLastMemoryWriteResult(),
      active_github_sync: this.proposalState.getActiveGitHubSync(),
      last_github_sync_result: this.proposalState.getLastGitHubSyncResult(),
      memory: this.memoryService.read(),
      recent_subagent_runs: this.subAgentService.listRecentRuns(),
    };
  }

  async sendMessage(input: SendAgentMessageDto): Promise<SendAgentMessageResult> {
    if (!input.message?.trim()) {
      throw new BadRequestException("message is required");
    }

    const session = await this.ensureSession();
    const prompt = this.contextService.formatForPrompt(
      this.contextService.assemble({
        graph_mode: input.context?.graph_mode,
        repo: input.context?.repo,
        track: input.context?.track,
        session,
        user_message: input.message,
      }),
      input.message,
    );

    const queued = session.isStreaming;
    const promptPromise = queued
      ? session.prompt(prompt, { streamingBehavior: "followUp" })
      : session.prompt(prompt);

    void promptPromise.catch((error) => {
      this.logger.error(`Planner prompt failed: ${this.getErrorMessage(error)}`);
    });

    return {
      accepted: true,
      queued,
      session_id: session.sessionId,
      session_file: session.sessionFile,
    };
  }

  async approveProposal(input: ApproveMutationProposalDto): Promise<PlanningGraphCommitResult> {
    const proposalId = input.proposal_id?.trim();
    if (!proposalId) {
      throw new BadRequestException("proposal_id is required");
    }

    const approvedIds = Array.from(new Set((input.approved_mutation_ids ?? []).filter((id) => typeof id === "string" && id.trim())));
    if (approvedIds.length === 0) {
      throw new BadRequestException("approved_mutation_ids must contain at least one mutation id");
    }

    const proposal = this.proposalState.getProposal(proposalId);
    if (!proposal) {
      throw new BadRequestException(`Unknown proposal: ${proposalId}`);
    }

    const selectedMutations = approvedIds.map((id) => {
      const mutation = proposal.mutations.find((candidate: PlanningMutationProposalMutation) => candidate.id === id);
      if (!mutation) {
        throw new BadRequestException(`Unknown mutation id for proposal ${proposalId}: ${id}`);
      }
      return mutation;
    });

    const result = this.graphWriter.apply({
      proposal_id: proposal.proposal_id,
      based_on_graph_version: proposal.context?.based_on_graph_version,
      mutations: selectedMutations.map((mutation) => this.toGraphMutation(mutation)),
    });

    const activeProposal = result.status === "applied"
      ? this.proposalState.updateActiveProposalAfterApply(proposal, approvedIds)
      : this.proposalState.getActiveProposal();

    const commitResult: PlanningGraphCommitResult = {
      proposal_id: proposal.proposal_id,
      approved_mutation_ids: approvedIds,
      result,
      active_proposal: activeProposal,
    };

    this.proposalState.setLastCommitResult(commitResult);
    this.emitStudioEvent("graph_commit_result", commitResult);

    return commitResult;
  }

  async approveMemoryChange(input: ApprovePlanningMemoryChangeDto): Promise<PlanningMemoryWriteResult> {
    const changeId = input.change_id?.trim();
    if (!changeId) {
      throw new BadRequestException("change_id is required");
    }

    const approvedEditIds = Array.from(new Set((input.approved_edit_ids ?? []).filter((id) => typeof id === "string" && id.trim())));
    if (approvedEditIds.length === 0) {
      throw new BadRequestException("approved_edit_ids must contain at least one edit id");
    }

    const change = this.proposalState.getMemoryChange(changeId);
    if (!change) {
      throw new BadRequestException(`Unknown memory change: ${changeId}`);
    }

    const { result, memory } = this.memoryService.applyChange(change, approvedEditIds);
    const activeMemoryChange = result.status === "applied"
      ? this.proposalState.updateActiveMemoryChangeAfterApply(change, approvedEditIds)
      : this.proposalState.getActiveMemoryChange();

    const writeResult: PlanningMemoryWriteResult = {
      change_id: change.change_id,
      approved_edit_ids: approvedEditIds,
      result,
      active_memory_change: activeMemoryChange,
      memory,
    };

    this.proposalState.setLastMemoryWriteResult(writeResult);
    this.emitStudioEvent("memory_write_result", writeResult);
    return writeResult;
  }

  async approveGitHubSync(input: ApproveGitHubSyncDto): Promise<GitHubSyncResult> {
    const syncId = input.sync_id?.trim();
    if (!syncId) {
      throw new BadRequestException("sync_id is required");
    }

    const approvedOperationIds = Array.from(new Set((input.approved_operation_ids ?? []).filter((id) => typeof id === "string" && id.trim())));
    if (approvedOperationIds.length === 0) {
      throw new BadRequestException("approved_operation_ids must contain at least one operation id");
    }

    const proposal = this.proposalState.getGitHubSync(syncId);
    if (!proposal) {
      throw new BadRequestException(`Unknown GitHub sync proposal: ${syncId}`);
    }

    const { result, issue } = await this.githubService.applySyncProposal(proposal, approvedOperationIds);
    const activeGitHubSync = result.status === "applied"
      ? this.proposalState.updateActiveGitHubSyncAfterApply(proposal, approvedOperationIds)
      : this.proposalState.getActiveGitHubSync();

    const syncResult: GitHubSyncResult = {
      sync_id: proposal.sync_id,
      approved_operation_ids: approvedOperationIds,
      result,
      active_github_sync: activeGitHubSync,
      issue,
    };

    this.proposalState.setLastGitHubSyncResult(syncResult);
    this.emitStudioEvent("github_sync_result", syncResult);
    return syncResult;
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) {
      return this.session;
    }

    if (!this.sessionPromise) {
      this.sessionPromise = this.createOrResumeSession().catch((error) => {
        this.sessionPromise = undefined;
        throw error;
      });
    }

    this.session = await this.sessionPromise;
    return this.session;
  }

  private async createOrResumeSession(): Promise<AgentSession> {
    mkdirSync(this.sessionDir, { recursive: true });

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: SessionManager.continueRecent(process.cwd(), this.sessionDir),
      model: this.settingsService.getSelectedModel(),
      customTools: createPlanningTools(this.buildToolDeps()),
    });

    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    this.unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(event);
    });

    this.logger.log(`Root planner ready: ${session.sessionId} (${session.sessionFile ?? "in-memory"})`);
    return session;
  }

  private handleSessionEvent(event: AgentSessionEvent) {
    if (event.type === "turn_start") {
      this.currentTurnId = `turn_${String(++this.turnCounter).padStart(4, "0")}`;
      this.proposalState.resetTurnState();
    }

    if (!this.isStreamableEvent(event.type)) {
      return;
    }

    const envelope: StudioSseEnvelope = {
      event_id: `evt_${String(++this.eventCounter).padStart(6, "0")}`,
      stream_id: this.streamId,
      timestamp: this.now(),
      event_type: event.type,
      session_id: this.session?.sessionId ?? "planning-root",
      turn_id: this.currentTurnId,
      payload: event,
    };

    this.eventSubject.next({
      id: envelope.event_id,
      type: envelope.event_type,
      data: envelope,
    });

    if (event.type === "turn_end") {
      this.currentTurnId = null;
      this.proposalState.resetTurnState();
    }
  }

  /**
   * Phase 7 (#227): build the typed dependency bag the tool registry
   * factories receive. Bound to `this` so the SSE emitter / turn id /
   * session id callbacks stay private to PlanningService.
   */
  private buildToolDeps(): PlanningToolDeps {
    return {
      graphService: this.graphService,
      memoryService: this.memoryService,
      subAgentService: this.subAgentService,
      githubService: this.githubService,
      driftReportService: this.driftReportService,
      proposalState: this.proposalState,
      emitStudioEvent: (eventType, payload) => this.emitStudioEvent(eventType, payload),
      buildProposalDefaults: () => this.buildProposalDefaults(),
      getCurrentTurnId: () => this.currentTurnId,
    };
  }

  private toGraphMutation(mutation: PlanningMutationProposalMutation): GraphMutation {
    switch (mutation.type) {
      case "create_work_item": {
        const payload = mutation.payload as CreateWorkItemPayload | undefined;
        const id = mutation.entity_id ?? payload?.id;
        if (!id || !payload?.name || !payload.kind) {
          throw new BadRequestException(`Mutation ${mutation.id} is missing create_work_item payload fields`);
        }
        const workItem: CreateWorkItemDto = {
          ...payload,
          id,
          name: payload.name,
          kind: payload.kind,
        };
        return {
          mutation_id: mutation.id,
          kind: "create_work_item",
          work_item: workItem,
        };
      }

      case "update_work_item": {
        const id = mutation.entity_id;
        if (!id || !mutation.payload) {
          throw new BadRequestException(`Mutation ${mutation.id} is missing update_work_item payload fields`);
        }
        return {
          mutation_id: mutation.id,
          kind: "update_work_item",
          id,
          patch: mutation.payload as UpdateWorkItemDto,
        };
      }

      case "delete_work_item": {
        const id = mutation.entity_id;
        if (!id) {
          throw new BadRequestException(`Mutation ${mutation.id} is missing delete_work_item entity_id`);
        }
        const deleteMutation: DeleteWorkItemMutation = {
          mutation_id: mutation.id,
          kind: "delete_work_item",
          id,
        };
        return deleteMutation;
      }

      case "create_edge": {
        const payload = mutation.payload as CreateEdgePayload | undefined;
        if (!payload?.from_id || !payload.rel || !payload.to_id) {
          throw new BadRequestException(`Mutation ${mutation.id} is missing create_edge payload fields`);
        }
        const edge: CreateEdgeDto = {
          from_id: payload.from_id,
          rel: payload.rel as EdgeRel,
          to_id: payload.to_id,
          confidence: payload.confidence,
          meta: payload.meta,
        };
        return {
          mutation_id: mutation.id,
          kind: "create_edge",
          edge,
        };
      }

      case "delete_edge": {
        const payloadId = typeof mutation.payload?.id === "number"
          ? mutation.payload.id
          : typeof mutation.entity_id === "string"
            ? Number(mutation.entity_id)
            : Number.NaN;

        if (!Number.isInteger(payloadId)) {
          throw new BadRequestException(`Mutation ${mutation.id} is missing delete_edge id`);
        }

        const deleteMutation: DeleteEdgeMutation = {
          mutation_id: mutation.id,
          kind: "delete_edge",
          id: payloadId,
        };
        return deleteMutation;
      }
    }
  }

  dismissAllProposals(): { dismissed_proposal_ids: string[]; dismissed_memory_change_ids: string[]; dismissed_github_sync_ids: string[] } {
    const result = this.proposalState.dismissAll();
    this.logger.log(
      `Dismissed proposals: ${result.dismissed_proposal_ids.length} mutation, ${result.dismissed_memory_change_ids.length} memory, ${result.dismissed_github_sync_ids.length} GitHub sync`,
    );
    return result;
  }

  /**
   * Phase 7 (#227): passes the current turn + session context into
   * ProposalStateService's normalize* helpers so they can stamp the
   * `source` envelope on new proposals. Grouped in one helper so tool
   * bodies don't need to know the shape.
   */
  private buildProposalDefaults(): { currentTurnId: string | null; sessionId: string } {
    return {
      currentTurnId: this.currentTurnId,
      sessionId: this.session?.sessionId ?? "planning-root",
    };
  }

  private emitStudioEvent(eventType: string, payload: unknown) {
    const envelope: StudioSseEnvelope = {
      event_id: `evt_${String(++this.eventCounter).padStart(6, "0")}`,
      stream_id: this.streamId,
      timestamp: this.now(),
      event_type: eventType,
      session_id: this.session?.sessionId ?? "planning-root",
      turn_id: this.currentTurnId,
      payload,
    };

    this.eventSubject.next({
      id: envelope.event_id,
      type: envelope.event_type,
      data: envelope,
    });
  }

  private projectSessionEntries(entries: SessionEntry[]): PlanningSessionTranscriptEntry[] {
    const transcript: PlanningSessionTranscriptEntry[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") {
        continue;
      }

      const message = entry.message as unknown as Record<string, unknown>;
      const role = message["role"];
      const timestamp = typeof message["timestamp"] === "number"
        ? new Date(message["timestamp"] as number).toISOString()
        : entry.timestamp;

      if (role === "user") {
        transcript.push({
          id: entry.id,
          role: "user",
          content: this.stripStudioContext(this.messageContentToText(message)),
          timestamp,
        });
        continue;
      }

      if (role === "assistant") {
        transcript.push({
          id: entry.id,
          role: "assistant",
          content: this.messageContentToText(message),
          timestamp,
        });
        continue;
      }

      if (role === "toolResult") {
        transcript.push({
          id: entry.id,
          role: "tool",
          content: this.messageContentToText(message) || "(no tool output)",
          timestamp,
          tool_name: typeof message["toolName"] === "string" ? message["toolName"] : undefined,
          is_error: typeof message["isError"] === "boolean" ? message["isError"] : undefined,
        });
      }
    }

    return transcript.slice(-40);
  }

  private messageContentToText(message: Record<string, unknown>): string {
    const content = message["content"];

    if (typeof content === "string") {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((part) => {
        if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
          return typeof part.text === "string" ? part.text : "";
        }

        if (part && typeof part === "object" && "type" in part && part.type === "thinking" && "thinking" in part) {
          return typeof part.thinking === "string" ? part.thinking : "";
        }

        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  private stripStudioContext(content: string): string {
    const match = content.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/);
    return match ? match[1].trim() : content.trim();
  }

  private isStreamableEvent(type: AgentSessionEvent["type"]): boolean {
    return [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ].includes(type);
  }

  private now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
