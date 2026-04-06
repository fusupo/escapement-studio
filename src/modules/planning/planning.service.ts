import { BadRequestException, Inject, Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Type } from "@sinclair/typebox";
import { createAgentSession, defineTool, SessionManager, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@mariozechner/pi-coding-agent";
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
import { SubAgentService } from "./sub-agent.service.js";
import type {
  ApproveGitHubSyncDto,
  ApproveMutationProposalDto,
  ApprovePlanningMemoryChangeDto,
  CreateEdgePayload,
  CreateWorkItemPayload,
  DelegateSubAgentToolInput,
  GitHubReadToolInput,
  GitHubSyncProposal,
  GitHubSyncResult,
  GitHubSyncToolInput,
  GraphQueryToolInput,
  PlanningGraphCommitResult,
  PlanningMemoryChange,
  PlanningMemoryEdit,
  PlanningMemoryWriteResult,
  PlanningMutationProposal,
  PlanningMutationProposalMutation,
  PlanningSessionSnapshot,
  PlanningSessionTranscriptEntry,
  ProposeMemoryWriteToolInput,
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
  private readonly memoryChanges = new Map<string, PlanningMemoryChange>();
  private readonly githubSyncs = new Map<string, GitHubSyncProposal>();

  private session?: AgentSession;
  private sessionPromise?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private eventCounter = 0;
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private activeProposalId: string | null = null;
  private lastCommitResult: PlanningGraphCommitResult | null = null;
  private activeMemoryChangeId: string | null = null;
  private lastMemoryWriteResult: PlanningMemoryWriteResult | null = null;
  private activeGitHubSyncId: string | null = null;
  private lastGitHubSyncResult: GitHubSyncResult | null = null;

  constructor(
    @Inject(ContextService) private readonly contextService: ContextService,
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
    @Inject(MemoryService) private readonly memoryService: MemoryService,
    @Inject(SubAgentService) private readonly subAgentService: SubAgentService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
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
      active_memory_change: this.getActiveMemoryChange(),
      last_memory_write_result: this.lastMemoryWriteResult,
      active_github_sync: this.getActiveGitHubSync(),
      last_github_sync_result: this.lastGitHubSyncResult,
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

  async approveMemoryChange(input: ApprovePlanningMemoryChangeDto): Promise<PlanningMemoryWriteResult> {
    const changeId = input.change_id?.trim();
    if (!changeId) {
      throw new BadRequestException("change_id is required");
    }

    const approvedEditIds = Array.from(new Set((input.approved_edit_ids ?? []).filter((id) => typeof id === "string" && id.trim())));
    if (approvedEditIds.length === 0) {
      throw new BadRequestException("approved_edit_ids must contain at least one edit id");
    }

    const change = this.memoryChanges.get(changeId);
    if (!change) {
      throw new BadRequestException(`Unknown memory change: ${changeId}`);
    }

    const { result, memory } = this.memoryService.applyChange(change, approvedEditIds);
    const activeMemoryChange = result.status === "applied"
      ? this.updateActiveMemoryChangeAfterApply(change, approvedEditIds)
      : this.getActiveMemoryChange();

    const writeResult: PlanningMemoryWriteResult = {
      change_id: change.change_id,
      approved_edit_ids: approvedEditIds,
      result,
      active_memory_change: activeMemoryChange,
      memory,
    };

    this.lastMemoryWriteResult = writeResult;
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

    const proposal = this.githubSyncs.get(syncId);
    if (!proposal) {
      throw new BadRequestException(`Unknown GitHub sync proposal: ${syncId}`);
    }

    const { result, issue } = await this.githubService.applySyncProposal(proposal, approvedOperationIds);
    const activeGitHubSync = result.status === "applied"
      ? this.updateActiveGitHubSyncAfterApply(proposal, approvedOperationIds)
      : this.getActiveGitHubSync();

    const syncResult: GitHubSyncResult = {
      sync_id: proposal.sync_id,
      approved_operation_ids: approvedOperationIds,
      result,
      active_github_sync: activeGitHubSync,
      issue,
    };

    this.lastGitHubSyncResult = syncResult;
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
      customTools: [
        this.createGraphQueryTool(),
        this.createProposeMutationsTool(),
        this.createGraphMutateTool(),
        this.createMemoryReadTool(),
        this.createMemoryWriteTool(),
        this.createDelegateSubAgentTool(),
        this.createGitHubReadTool(),
        this.createGitHubSyncTool(),
      ],
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

  private createMemoryReadTool() {
    return defineTool({
      name: "memory_read",
      label: "Planning Memory Read",
      description: "Read the curated durable planning memory file.",
      promptSnippet: "memory_read: inspect the curated planning memory before proposing durable memory changes.",
      promptGuidelines: [
        "Use memory_read before suggesting durable planning-memory edits so you can update the existing curated structure intentionally.",
      ],
      parameters: Type.Object({}),
      execute: async () => {
        const memory = this.memoryService.read();
        return {
          content: [{ type: "text", text: memory.content }],
          details: memory,
        };
      },
    });
  }

  private createMemoryWriteTool() {
    return defineTool({
      name: "memory_write",
      label: "Planning Memory Write",
      description: "Stage targeted planning memory edits for browser approval.",
      promptSnippet: "memory_write: stage targeted edits to PLANNING_MEMORY.md for browser approval instead of writing directly.",
      promptGuidelines: [
        "Use memory_write only for durable, curated planning-memory updates.",
        "Prefer targeted replacements or section-specific inserts over append-only growth.",
        "Do not include transcript residue, raw tool output, or broad dumps.",
      ],
      parameters: Type.Object({
        change_id: Type.Optional(Type.String()),
        created_at: Type.Optional(Type.String()),
        source: Type.Optional(Type.Object({
          agent: Type.Optional(Type.String()),
          turn_id: Type.Optional(Type.String()),
          session_id: Type.Optional(Type.String()),
        })),
        summary: Type.String(),
        edits: Type.Array(Type.Object({
          id: Type.Optional(Type.String()),
          kind: Type.Union([
            Type.Literal("replace_text"),
            Type.Literal("insert_after_heading"),
            Type.Literal("delete_text"),
          ]),
          summary: Type.String(),
          rationale: Type.String(),
          old_text: Type.Optional(Type.String()),
          new_text: Type.Optional(Type.String()),
          target_heading: Type.Optional(Type.String()),
        })),
      }),
      execute: async (_toolCallId, params: ProposeMemoryWriteToolInput) => {
        const change = this.normalizeMemoryChange(params);
        this.memoryChanges.set(change.change_id, change);
        this.activeMemoryChangeId = change.change_id;
        this.lastMemoryWriteResult = null;
        this.emitStudioEvent("memory_change_proposal", { change });

        return {
          content: [{ type: "text", text: `Staged planning memory change ${change.change_id} with ${change.edits.length} edit(s).` }],
          details: { change },
        };
      },
    });
  }

  private createDelegateSubAgentTool() {
    return defineTool({
      name: "delegate_subagent",
      label: "Delegate Sub-agent",
      description: "Launch a bounded specialist run for repo research and return a structured result.",
      promptSnippet: "delegate_subagent: delegate bounded code research to a structured specialist when the planner needs grounded repo evidence.",
      promptGuidelines: [
        "Use delegate_subagent when you need grounded repository evidence beyond quick direct reasoning.",
        "Pick code-crawler for concrete implementation tracing and scope-predictor for bounded impact prediction.",
        "Keep the delegated task narrow and include focus paths or work item ids when useful.",
      ],
      parameters: Type.Object({
        agent_type: Type.Union([Type.Literal("code-crawler"), Type.Literal("scope-predictor")]),
        task: Type.String(),
        repo: Type.Optional(Type.String()),
        focus_paths: Type.Optional(Type.Array(Type.String())),
        work_item_ids: Type.Optional(Type.Array(Type.String())),
        notes: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params: DelegateSubAgentToolInput) => {
        const run = await this.subAgentService.runDelegation(params, {
          onStatus: (nextRun) => this.emitStudioEvent("subagent_status", { run: nextRun }),
          onResult: (nextRun) => this.emitStudioEvent("subagent_result", { run: nextRun }),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(run.result ?? run, null, 2) }],
          details: { run },
        };
      },
    });
  }

  private createGitHubReadTool() {
    return defineTool({
      name: "github_read",
      label: "GitHub Read",
      description: "Read GitHub issue details for an issue-backed work item or repo issue.",
      promptSnippet: "github_read: inspect GitHub issue details before making GitHub sync recommendations.",
      promptGuidelines: [
        "Use github_read when you need grounded issue details from GitHub rather than relying only on graph metadata.",
        "Prefer the work item's repo + issue_number when available.",
      ],
      parameters: Type.Object({
        repo: Type.String(),
        issue_number: Type.Number(),
      }),
      execute: async (_toolCallId, params: GitHubReadToolInput) => {
        const issue = await this.githubService.readIssue(params.repo, params.issue_number);
        return {
          content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
          details: issue,
        };
      },
    });
  }

  private createGitHubSyncTool() {
    return defineTool({
      name: "github_sync",
      label: "GitHub Sync",
      description: "Stage an approval-gated GitHub sync proposal for a GitHub-backed work item.",
      promptSnippet: "github_sync: stage a structured GitHub sync proposal for browser approval instead of mutating GitHub directly.",
      promptGuidelines: [
        "Use github_sync only for narrow, non-destructive GitHub updates.",
        "V1 sync supports only the machine-managed issue body block bounded by studio-sync markers.",
        "Do not attempt direct GitHub mutation outside the approval flow.",
      ],
      parameters: Type.Object({
        sync_id: Type.Optional(Type.String()),
        created_at: Type.Optional(Type.String()),
        source: Type.Optional(Type.Object({
          agent: Type.Optional(Type.String()),
          turn_id: Type.Optional(Type.String()),
          session_id: Type.Optional(Type.String()),
        })),
        summary: Type.String(),
        work_item_id: Type.String(),
      }),
      execute: async (_toolCallId, params: GitHubSyncToolInput) => {
        const sync = await this.normalizeGitHubSync(params);
        this.githubSyncs.set(sync.sync_id, sync);
        this.activeGitHubSyncId = sync.sync_id;
        this.lastGitHubSyncResult = null;
        this.emitStudioEvent("github_sync_proposal", { sync });

        return {
          content: [{ type: "text", text: `Staged GitHub sync ${sync.sync_id} with ${sync.operations.length} operation(s).` }],
          details: { sync },
        };
      },
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

  private normalizeMemoryChange(input: ProposeMemoryWriteToolInput): PlanningMemoryChange {
    const memory = this.memoryService.read();
    const changeId = input.change_id?.trim() || `mem_${Date.now()}`;
    const createdAt = input.created_at?.trim() || this.now();

    return {
      change_id: changeId,
      created_at: createdAt,
      source: {
        agent: input.source?.agent?.trim() || "root-planner",
        turn_id: input.source?.turn_id?.trim() || this.currentTurnId,
        session_id: input.source?.session_id?.trim() || this.session?.sessionId || "planning-root",
      },
      summary: input.summary.trim(),
      based_on_content_hash: memory.content_hash,
      edits: input.edits.map((edit, index) => this.normalizeMemoryEdit(edit, index)),
    };
  }

  private async normalizeGitHubSync(input: GitHubSyncToolInput): Promise<GitHubSyncProposal> {
    const staged = await this.githubService.stageManagedBlockSync(input.work_item_id);
    return {
      sync_id: input.sync_id?.trim() || `ghsync_${Date.now()}`,
      created_at: input.created_at?.trim() || this.now(),
      source: {
        agent: input.source?.agent?.trim() || "root-planner",
        turn_id: input.source?.turn_id?.trim() || this.currentTurnId,
        session_id: input.source?.session_id?.trim() || this.session?.sessionId || "planning-root",
      },
      summary: input.summary.trim(),
      issue: {
        repo: staged.issue.repo,
        issue_number: staged.issue.number,
        issue_url: staged.issue.url,
        title: staged.issue.title,
      },
      work_item_id: staged.work_item_id,
      based_on_body_hash: staged.based_on_body_hash,
      operations: staged.operations,
    };
  }

  private normalizeMemoryEdit(edit: ProposeMemoryWriteToolInput["edits"][number], index: number): PlanningMemoryEdit {
    return {
      id: edit.id?.trim() || `e${index + 1}`,
      kind: edit.kind,
      summary: edit.summary.trim(),
      rationale: edit.rationale.trim(),
      old_text: edit.old_text,
      new_text: edit.new_text,
      target_heading: edit.target_heading,
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

  private updateActiveMemoryChangeAfterApply(
    change: PlanningMemoryChange,
    approvedEditIds: string[],
  ): PlanningMemoryChange | null {
    const remainingEdits = change.edits.filter((edit) => !approvedEditIds.includes(edit.id));

    if (remainingEdits.length === 0) {
      this.memoryChanges.delete(change.change_id);
      if (this.activeMemoryChangeId === change.change_id) {
        this.activeMemoryChangeId = null;
      }
      return null;
    }

    const nextChange: PlanningMemoryChange = {
      ...change,
      summary: `${change.summary} (${remainingEdits.length} edit(s) remaining)`,
      edits: remainingEdits,
      based_on_content_hash: this.memoryService.read().content_hash,
    };
    this.memoryChanges.set(nextChange.change_id, nextChange);
    this.activeMemoryChangeId = nextChange.change_id;
    return nextChange;
  }

  private updateActiveGitHubSyncAfterApply(
    proposal: GitHubSyncProposal,
    approvedOperationIds: string[],
  ): GitHubSyncProposal | null {
    const remainingOperations = proposal.operations.filter((operation) => !approvedOperationIds.includes(operation.id));

    if (remainingOperations.length === 0) {
      this.githubSyncs.delete(proposal.sync_id);
      if (this.activeGitHubSyncId === proposal.sync_id) {
        this.activeGitHubSyncId = null;
      }
      return null;
    }

    const nextProposal: GitHubSyncProposal = {
      ...proposal,
      summary: `${proposal.summary} (${remainingOperations.length} operation(s) remaining)`,
      operations: remainingOperations,
    };
    this.githubSyncs.set(nextProposal.sync_id, nextProposal);
    this.activeGitHubSyncId = nextProposal.sync_id;
    return nextProposal;
  }

  private getActiveProposal(): PlanningMutationProposal | null {
    return this.activeProposalId ? this.proposals.get(this.activeProposalId) ?? null : null;
  }

  private getActiveMemoryChange(): PlanningMemoryChange | null {
    return this.activeMemoryChangeId ? this.memoryChanges.get(this.activeMemoryChangeId) ?? null : null;
  }

  private getActiveGitHubSync(): GitHubSyncProposal | null {
    return this.activeGitHubSyncId ? this.githubSyncs.get(this.activeGitHubSyncId) ?? null : null;
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
