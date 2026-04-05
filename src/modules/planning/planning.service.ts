import { BadRequestException, Inject, Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Type } from "@sinclair/typebox";
import { createAgentSession, defineTool, SessionManager, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Observable, Subject } from "rxjs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../../config.js";
import { GraphService } from "../graph/graph.service.js";
import { GraphWriterService } from "../graph/graph-writer.service.js";
import type {
  ApplyGraphMutationsResult,
  CreateEdgeDto,
  CreateWorkItemDto,
  DeleteEdgeMutation,
  DeleteWorkItemMutation,
  EdgeRel,
  GraphMutation,
  UpdateWorkItemDto,
} from "../graph/types.js";
import { ContextService } from "./context.service.js";
import type {
  ApproveMutationProposalDto,
  CreateEdgePayload,
  CreateWorkItemPayload,
  GraphQueryToolInput,
  PlanningGraphCommitResult,
  PlanningMutationProposal,
  PlanningMutationProposalMutation,
  PlanningSessionSnapshot,
  PlanningSessionTranscriptEntry,
  ProposeMutationsToolInput,
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
  private readonly proposals = new Map<string, PlanningMutationProposal>();

  private session?: AgentSession;
  private sessionPromise?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private eventCounter = 0;
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private activeProposalId: string | null = null;
  private lastCommitResult: PlanningGraphCommitResult | null = null;

  constructor(
    @Inject(ContextService) private readonly contextService: ContextService,
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
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
      active_proposal: this.getActiveProposal(),
      last_commit_result: this.lastCommitResult,
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

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new BadRequestException(`Unknown proposal: ${proposalId}`);
    }

    const selectedMutations = approvedIds.map((id) => {
      const mutation = proposal.mutations.find((candidate) => candidate.id === id);
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
      ? this.updateActiveProposalAfterApply(proposal, approvedIds)
      : this.getActiveProposal();

    const commitResult: PlanningGraphCommitResult = {
      proposal_id: proposal.proposal_id,
      approved_mutation_ids: approvedIds,
      result,
      active_proposal: activeProposal,
    };

    this.lastCommitResult = commitResult;
    this.emitStudioEvent("graph_commit_result", commitResult);

    return commitResult;
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
      customTools: [this.createGraphQueryTool(), this.createProposeMutationsTool(), this.createGraphMutateTool()],
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
    }
  }

  private createGraphQueryTool() {
    return defineTool({
      name: "graph_query",
      label: "Graph Query",
      description: "Query the Studio planning graph, frontier, or dispatch plan.",
      promptSnippet: "graph_query: inspect graph, frontier, or dispatch plan data before proposing structural changes.",
      promptGuidelines: [
        "Use graph_query to inspect the current graph/frontier/plan before proposing structural graph changes.",
      ],
      parameters: Type.Object({
        query: Type.Union([Type.Literal("graph"), Type.Literal("frontier"), Type.Literal("plan")]),
        repo: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        track: Type.Optional(Type.String()),
        phase: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params: GraphQueryToolInput) => {
        const result = params.query === "graph"
          ? this.graphService.getGraph({
              repo: params.repo,
              state: params.state,
              track: params.track,
              phase: params.phase,
            })
          : params.query === "frontier"
            ? this.graphService.getFrontier(params.repo)
            : this.graphService.getPlan(params.repo);

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });
  }

  private createProposeMutationsTool() {
    return defineTool({
      name: "propose_mutations",
      label: "Propose Mutations",
      description: "Stage a structured graph mutation proposal for browser review and approval.",
      promptSnippet: "propose_mutations: emit a structured mutation proposal envelope for browser approval instead of only describing changes in prose.",
      promptGuidelines: [
        "When recommending graph changes, call propose_mutations with a structured proposal envelope that matches the browser approval contract.",
        "Include a concise summary plus rationale for each mutation so the browser can render reviewable cards.",
        "Set based_on_graph_version from graph_query results when available.",
      ],
      parameters: Type.Object({
        proposal_id: Type.Optional(Type.String()),
        created_at: Type.Optional(Type.String()),
        source: Type.Optional(Type.Object({
          agent: Type.Optional(Type.String()),
          turn_id: Type.Optional(Type.String()),
          session_id: Type.Optional(Type.String()),
        })),
        context: Type.Optional(Type.Object({
          scope: Type.Optional(Type.String()),
          mode: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("focused"), Type.Literal("full")])) ,
          based_on_graph_version: Type.Optional(Type.String()),
        })),
        summary: Type.String(),
        mutations: Type.Array(Type.Object({
          id: Type.Optional(Type.String()),
          type: Type.Union([
            Type.Literal("create_work_item"),
            Type.Literal("update_work_item"),
            Type.Literal("create_edge"),
            Type.Literal("delete_edge"),
            Type.Literal("delete_work_item"),
          ]),
          entity_id: Type.Optional(Type.String()),
          payload: Type.Optional(Type.Any()),
          rationale: Type.String(),
          validation: Type.Optional(Type.Any()),
          group_id: Type.Optional(Type.String()),
          depends_on_mutation_ids: Type.Optional(Type.Array(Type.String())),
        })),
      }),
      execute: async (_toolCallId, params: ProposeMutationsToolInput) => {
        const proposal = this.normalizeProposal(params);
        this.proposals.set(proposal.proposal_id, proposal);
        this.activeProposalId = proposal.proposal_id;
        this.lastCommitResult = null;
        this.emitStudioEvent("mutation_proposal", { proposal });

        return {
          content: [{ type: "text", text: `Staged proposal ${proposal.proposal_id} with ${proposal.mutations.length} mutation(s).` }],
          details: { proposal },
        };
      },
    });
  }

  private createGraphMutateTool() {
    return defineTool({
      name: "graph_mutate",
      label: "Graph Mutate",
      description: "Reserved graph commit tool. In V1, actual commits must go through browser approval.",
      promptSnippet: "graph_mutate: reserved for approval-backed graph commits; do not call directly in V1.",
      promptGuidelines: [
        "Do not call graph_mutate directly in V1. Human approval in the browser is required; use propose_mutations instead.",
      ],
      parameters: Type.Object({
        proposal_id: Type.String(),
        approved_mutation_ids: Type.Array(Type.String()),
      }),
      execute: async (_toolCallId, params: ApproveMutationProposalDto) => ({
        content: [{
          type: "text",
          text: `Direct graph_mutate execution is disabled in V1. Proposal ${params.proposal_id} must be committed from the browser approval UI.`,
        }],
        details: {
          blocked: true,
          reason: "browser_approval_required",
          proposal_id: params.proposal_id,
          approved_mutation_ids: params.approved_mutation_ids,
        },
      }),
    });
  }

  private normalizeProposal(input: ProposeMutationsToolInput): PlanningMutationProposal {
    const graphVersion = input.context?.based_on_graph_version ?? this.graphService.getGraph().graph_version;
    const proposalId = input.proposal_id?.trim() || `prop_${Date.now()}`;
    const createdAt = input.created_at?.trim() || this.now();

    return {
      proposal_id: proposalId,
      created_at: createdAt,
      source: {
        agent: input.source?.agent?.trim() || "root-planner",
        turn_id: input.source?.turn_id?.trim() || this.currentTurnId,
        session_id: input.source?.session_id?.trim() || this.session?.sessionId || "planning-root",
      },
      context: {
        ...input.context,
        based_on_graph_version: graphVersion,
      },
      summary: input.summary.trim(),
      mutations: input.mutations.map((mutation, index) => this.normalizeProposalMutation(mutation, index)),
    };
  }

  private normalizeProposalMutation(
    mutation: ProposeMutationsToolInput["mutations"][number],
    index: number,
  ): PlanningMutationProposalMutation {
    const payload = mutation.payload && typeof mutation.payload === "object"
      ? { ...(mutation.payload as Record<string, unknown>) }
      : undefined;

    const entityId = mutation.entity_id
      ?? (typeof payload?.id === "string" ? payload.id : undefined)
      ?? (mutation.type === "create_edge" && payload
        ? `${String(payload.from_id ?? "")}:${String(payload.rel ?? "")}:${String(payload.to_id ?? "")}`
        : undefined);

    return {
      id: mutation.id?.trim() || `m${index + 1}`,
      type: mutation.type,
      entity_id: entityId,
      payload,
      rationale: mutation.rationale.trim(),
      validation: mutation.validation,
      group_id: mutation.group_id,
      depends_on_mutation_ids: mutation.depends_on_mutation_ids,
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

  private updateActiveProposalAfterApply(
    proposal: PlanningMutationProposal,
    approvedIds: string[],
  ): PlanningMutationProposal | null {
    const remainingMutations = proposal.mutations.filter((mutation) => !approvedIds.includes(mutation.id));

    if (remainingMutations.length === 0) {
      this.proposals.delete(proposal.proposal_id);
      if (this.activeProposalId === proposal.proposal_id) {
        this.activeProposalId = null;
      }
      return null;
    }

    const nextProposal: PlanningMutationProposal = {
      ...proposal,
      summary: `${proposal.summary} (${remainingMutations.length} mutation(s) remaining)`,
      mutations: remainingMutations,
    };
    this.proposals.set(nextProposal.proposal_id, nextProposal);
    this.activeProposalId = nextProposal.proposal_id;
    return nextProposal;
  }

  private getActiveProposal(): PlanningMutationProposal | null {
    return this.activeProposalId ? this.proposals.get(this.activeProposalId) ?? null : null;
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
