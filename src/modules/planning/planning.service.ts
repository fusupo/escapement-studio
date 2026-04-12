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
import {
  deriveIssueWorkItemId,
  type CreateEdgeDto,
  type CreateWorkItemDto,
  type DeleteEdgeMutation,
  type DeleteWorkItemMutation,
  type EdgeRel,
  type GraphMutation,
  type UpdateWorkItemDto,
} from "../graph/types.js";
import { ContextService } from "./context.service.js";
import { MemoryService } from "./memory.service.js";
import { SubAgentService } from "./sub-agent.service.js";
import { ReconciliationService } from "../reconciliation/reconciliation.service.js";
import { SettingsService } from "../settings/settings.service.js";
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
  ReconciliationQueryToolInput,
  GitHubCreateIssueToolInput,
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
  private readonly issueIdAliases = new Map<string, string>();

  private session?: AgentSession;
  private sessionPromise?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private eventCounter = 0;
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private activeProposalId: string | null = null;
  private proposalCounter = 0;
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
    @Inject(ReconciliationService) private readonly reconciliationService: ReconciliationService,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
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
      model: this.settingsService.getSelectedModel(),
      customTools: [
        this.createGraphQueryTool(),
        this.createProposeMutationsTool(),
        this.createGraphMutateTool(),
        this.createMemoryReadTool(),
        this.createMemoryWriteTool(),
        this.createDelegateSubAgentTool(),
        this.createGitHubReadTool(),
        this.createGitHubCreateIssueTool(),
        this.createGitHubSyncTool(),
        this.createReconciliationQueryTool(),
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
      this.issueIdAliases.clear();
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
      this.issueIdAliases.clear();
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
        agent_type: Type.Union([Type.Literal("code-crawler"), Type.Literal("scope-predictor"), Type.Literal("reconciliation-analyst")]),
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

  private createGitHubCreateIssueTool() {
    return defineTool({
      name: "github_create_issue",
      label: "GitHub Create Issue",
      description: "Create a GitHub issue with a polished body and automatically stage a graph work item proposal for browser approval.",
      promptSnippet: "github_create_issue: draft a rich GitHub issue body and auto-stage the corresponding graph work item proposal in one step.",
      promptGuidelines: [
        "Use github_create_issue when the user asks to create a new issue — it handles both GitHub issue creation and graph proposal staging.",
        "Prefer richer issue bodies by default. Unless the user explicitly wants a quick capture, include background or motivation, the current problem, proposed behavior or expected vs actual behavior, scope or impact, and acceptance criteria.",
        "For under-specified requests, draft the proposed title/body in chat and confirm before calling the tool.",
        "Use lightweight repo context when it will materially improve the issue body — for example relevant docs, nearby module/file names, and any canonical Escapement Studio issue drafting template included in prompt context.",
        "Keep issue text grounded in the user's request and repo evidence; do not invent repro steps, implementation details, or acceptance criteria.",
        "The graph mutation proposal is staged automatically for browser approval; no separate propose_mutations call is needed.",
        "Provide a work_item_id that follows the project's naming convention (e.g. 'studio-57').",
        "Include scope_hint and predicted_files when available to enrich the graph node.",
        "Use parent_id and depends_on_ids to wire the new item into the graph hierarchy.",
      ],
      parameters: Type.Object({
        repo: Type.String(),
        title: Type.String(),
        body: Type.Optional(Type.String()),
        labels: Type.Optional(Type.Array(Type.String())),
        work_item_id: Type.Optional(Type.String()),
        scope_hint: Type.Optional(Type.String()),
        predicted_files: Type.Optional(Type.Array(Type.String())),
        parent_id: Type.Optional(Type.String()),
        depends_on_ids: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_toolCallId, params: GitHubCreateIssueToolInput) => {
        const created = await this.githubService.createIssue({
          repo: params.repo,
          title: params.title,
          body: params.body,
          labels: params.labels,
        });

        const existingProposal = this.getActiveProposalForAccumulation();
        const stagedWorkItemIds = this.getStagedWorkItemIds(existingProposal);
        const requestedWorkItemId = params.work_item_id?.trim();
        const workItemId = deriveIssueWorkItemId(created.number);
        this.rememberIssueIdAlias(requestedWorkItemId, workItemId, stagedWorkItemIds);

        const groupId = `issue-${created.number}`;
        const parentId = this.resolveIssueIdAlias(params.parent_id, stagedWorkItemIds);
        const dependsOnIds = params.depends_on_ids
          ?.map((depId) => this.resolveIssueIdAlias(depId, stagedWorkItemIds))
          .filter((depId): depId is string => Boolean(depId));

        const mutations: ProposeMutationsToolInput["mutations"] = [
          {
            type: "create_work_item",
            entity_id: workItemId,
            group_id: groupId,
            payload: {
              id: workItemId,
              name: created.title,
              kind: "issue",
              state: "planned",
              repo: params.repo,
              issue_number: created.number,
              issue_url: created.url,
              scope_hint: params.scope_hint ?? null,
              predicted_files: params.predicted_files ?? [],
            },
            rationale: `Graph representation for newly created GitHub issue #${created.number}.`,
          },
        ];

        if (parentId) {
          mutations.push({
            type: "create_edge",
            group_id: groupId,
            payload: {
              from_id: workItemId,
              rel: "is_part_of",
              to_id: parentId,
            },
            rationale: `Attach ${workItemId} under parent ${parentId}.`,
          });
        }

        if (dependsOnIds) {
          for (const depId of dependsOnIds) {
            mutations.push({
              type: "create_edge",
              group_id: groupId,
              payload: {
                from_id: workItemId,
                rel: "depends_on",
                to_id: depId,
              },
              rationale: `${workItemId} depends on ${depId}.`,
            });
          }
        }

        // Accumulate into existing active proposal from the same turn,
        // so multi-issue creation produces one reviewable proposal.
        let proposal: PlanningMutationProposal;

        if (existingProposal) {
          proposal = this.accumulateMutations(
            existingProposal,
            mutations,
            `+ GitHub issue #${created.number}: ${created.title}`,
          );
        } else {
          proposal = this.normalizeProposal({
            summary: `Graph work item for GitHub issue #${created.number}: ${created.title}`,
            mutations,
          });
        }

        proposal = this.rewriteProposalIssueAliases(proposal);

        this.proposals.set(proposal.proposal_id, proposal);
        this.activeProposalId = proposal.proposal_id;
        this.lastCommitResult = null;
        this.emitStudioEvent("mutation_proposal", { proposal });

        const summary = `Created GitHub issue #${created.number} (${created.url}) and staged graph proposal ${proposal.proposal_id} with ${proposal.mutations.length} mutation(s) for browser approval.`;

        return {
          content: [{ type: "text", text: summary }],
          details: {
            issue: created,
            proposal,
          },
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

  private createReconciliationQueryTool() {
    return defineTool({
      name: "reconciliation_query",
      label: "Reconciliation Query",
      description: "Read deterministic predicted-vs-actual reconciliation reports for recent or specific work items.",
      promptSnippet: "reconciliation_query: inspect reconciliation reports before explaining drift or proposing planning memory learnings.",
      promptGuidelines: [
        "Use reconciliation_query when you need deterministic predicted-vs-actual comparison data.",
        "Prefer a specific work_item_id when discussing one execution run or one work item's drift.",
      ],
      parameters: Type.Object({
        work_item_id: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params: ReconciliationQueryToolInput) => {
        const result = params.work_item_id
          ? this.reconciliationService.getReport(params.work_item_id)
          : this.reconciliationService.listReports();

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });
  }

  private normalizeProposal(input: ProposeMutationsToolInput): PlanningMutationProposal {
    const graphVersion = input.context?.based_on_graph_version ?? this.graphService.getGraph().graph_version;
    const proposalId = input.proposal_id?.trim() || `prop_${Date.now()}_${++this.proposalCounter}`;
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

  dismissAllProposals(): { dismissed_proposal_ids: string[]; dismissed_memory_change_ids: string[]; dismissed_github_sync_ids: string[] } {
    const dismissedProposalIds = this.activeProposalId ? [this.activeProposalId] : [];
    const dismissedMemoryChangeIds = this.activeMemoryChangeId ? [this.activeMemoryChangeId] : [];
    const dismissedGitHubSyncIds = this.activeGitHubSyncId ? [this.activeGitHubSyncId] : [];

    this.activeProposalId = null;
    this.lastCommitResult = null;
    this.activeMemoryChangeId = null;
    this.lastMemoryWriteResult = null;
    this.activeGitHubSyncId = null;
    this.lastGitHubSyncResult = null;

    this.logger.log(`Dismissed proposals: ${dismissedProposalIds.length} mutation, ${dismissedMemoryChangeIds.length} memory, ${dismissedGitHubSyncIds.length} GitHub sync`);

    return {
      dismissed_proposal_ids: dismissedProposalIds,
      dismissed_memory_change_ids: dismissedMemoryChangeIds,
      dismissed_github_sync_ids: dismissedGitHubSyncIds,
    };
  }

  private getActiveProposal(): PlanningMutationProposal | null {
    return this.activeProposalId ? this.proposals.get(this.activeProposalId) ?? null : null;
  }

  /**
   * Return the active proposal only if it was created in the current turn
   * and has not yet been committed — suitable for accumulating additional
   * mutations from a second github_create_issue call in the same flow.
   */
  private getActiveProposalForAccumulation(): PlanningMutationProposal | null {
    const proposal = this.getActiveProposal();
    if (!proposal || !this.currentTurnId) {
      return null;
    }
    // Only accumulate when the existing proposal belongs to this turn
    if (proposal.source.turn_id !== this.currentTurnId) {
      return null;
    }
    return proposal;
  }

  /**
   * Append new mutations to an existing proposal, re-numbering their IDs
   * to avoid collisions. Returns the updated (same-ID) proposal.
   */
  private accumulateMutations(
    existing: PlanningMutationProposal,
    newMutations: ProposeMutationsToolInput["mutations"],
    summaryAppendix: string,
  ): PlanningMutationProposal {
    // Find the highest existing numeric suffix to avoid ID collisions
    const maxExistingIndex = existing.mutations.reduce((max, mutation) => {
      const match = mutation.id.match(/^m(\d+)$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);

    let nextIndex = maxExistingIndex + 1;
    const normalized = newMutations.map((mutation) =>
      this.normalizeProposalMutation(
        { ...mutation, id: `m${nextIndex++}` },
        0, // index param unused when id is pre-set
      ),
    );

    return {
      ...existing,
      summary: `${existing.summary} ${summaryAppendix}`,
      mutations: [...existing.mutations, ...normalized],
    };
  }

  private rememberIssueIdAlias(
    requestedId: string | null | undefined,
    finalId: string,
    stagedWorkItemIds: ReadonlySet<string> = new Set(),
  ) {
    const placeholderId = requestedId?.trim();
    if (!placeholderId || placeholderId === finalId) {
      return;
    }
    // If the requested ID is already staged as a canonical work item from an
    // earlier create, or already resolves to one, treat that existing staged ID
    // as authoritative and do not overwrite the alias chain with a later guess.
    if (stagedWorkItemIds.has(placeholderId)) {
      return;
    }
    const existingResolvedId = this.resolveIssueIdAlias(placeholderId, stagedWorkItemIds);
    if (existingResolvedId !== placeholderId && stagedWorkItemIds.has(existingResolvedId)) {
      return;
    }
    this.issueIdAliases.set(placeholderId, finalId);
  }

  private resolveIssueIdAlias(id: string | null | undefined, stopIds: ReadonlySet<string> = new Set()): string {
    const trimmed = id?.trim();
    if (!trimmed) {
      return "";
    }
    if (stopIds.has(trimmed)) {
      return trimmed;
    }

    let resolved = trimmed;
    const seen = new Set<string>();

    while (this.issueIdAliases.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      const next = this.issueIdAliases.get(resolved) ?? resolved;
      resolved = next;
      if (stopIds.has(resolved)) {
        break;
      }
    }

    return resolved;
  }

  private getStagedWorkItemIds(proposal: PlanningMutationProposal | null | undefined): Set<string> {
    const ids = new Set<string>();
    if (!proposal) {
      return ids;
    }

    for (const mutation of proposal.mutations) {
      if (mutation.type !== "create_work_item") {
        continue;
      }
      if (mutation.entity_id) {
        ids.add(mutation.entity_id);
      }
      if (typeof mutation.payload?.id === "string") {
        ids.add(mutation.payload.id);
      }
    }

    return ids;
  }

  private rewriteProposalIssueAliases(proposal: PlanningMutationProposal): PlanningMutationProposal {
    const stagedWorkItemIds = this.getStagedWorkItemIds(proposal);
    return {
      ...proposal,
      mutations: proposal.mutations.map((mutation) => this.rewriteProposalMutationIssueAliases(mutation, stagedWorkItemIds)),
    };
  }

  private rewriteProposalMutationIssueAliases(
    mutation: PlanningMutationProposalMutation,
    stagedWorkItemIds: ReadonlySet<string>,
  ): PlanningMutationProposalMutation {
    const payload = mutation.payload && typeof mutation.payload === "object"
      ? { ...mutation.payload }
      : undefined;

    const entityId = mutation.entity_id ? this.resolveIssueIdAlias(mutation.entity_id, stagedWorkItemIds) : mutation.entity_id;

    if (mutation.type === "create_work_item" || mutation.type === "update_work_item") {
      if (typeof payload?.id === "string") {
        payload.id = this.resolveIssueIdAlias(payload.id, stagedWorkItemIds);
      }
    }

    if (mutation.type === "create_edge") {
      if (typeof payload?.from_id === "string") {
        payload.from_id = this.resolveIssueIdAlias(payload.from_id, stagedWorkItemIds);
      }
      if (typeof payload?.to_id === "string") {
        payload.to_id = this.resolveIssueIdAlias(payload.to_id, stagedWorkItemIds);
      }
    }

    const rewrittenEntityId = mutation.type === "create_edge" && payload?.from_id && payload?.rel && payload?.to_id
      ? `${String(payload.from_id)}:${String(payload.rel)}:${String(payload.to_id)}`
      : entityId;

    return {
      ...mutation,
      entity_id: rewrittenEntityId,
      payload,
    };
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
