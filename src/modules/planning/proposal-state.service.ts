import { Inject, Injectable } from "@nestjs/common";
import { GraphService } from "../graph/graph.service.js";
import { GitHubService } from "../github/github.service.js";
import { MemoryService } from "./memory.service.js";
import type {
  GitHubSyncProposal,
  GitHubSyncToolInput,
  PlanningGraphCommitResult,
  PlanningMemoryChange,
  PlanningMemoryEdit,
  PlanningMemoryWriteResult,
  PlanningMutationProposal,
  PlanningMutationProposalMutation,
  ProposeMemoryWriteToolInput,
  ProposeMutationsToolInput,
  GitHubSyncResult,
} from "./types.js";

/**
 * Phase 7 of the cqrs refactor (#227): owns the staging state that
 * the planner's custom tools accumulate (mutation proposals, memory
 * changes, GitHub syncs) plus the helper methods that normalize,
 * accumulate, and alias-resolve those proposals.
 *
 * Extracted from `PlanningService` to get 11 state fields + 17 helper
 * methods out of the 1378-line god class. `PlanningService` now
 * delegates every state read/write to this service, and the planner
 * tool files (Phase 7 Task 2) will inject `ProposalStateService`
 * directly via their dependency bag.
 *
 * Injects:
 *   - `GraphService` — for `graph_version` in `normalizeProposal`
 *   - `GitHubService` — for `stageManagedBlockSync` in `normalizeGitHubSync`
 *   - `MemoryService` — for `content_hash` in `normalizeMemoryChange`
 *     + the refreshed hash in `updateActiveMemoryChangeAfterApply`
 *
 * Does NOT inject anything new at the module level — all three
 * siblings are already available to `PlanningModule`.
 */
@Injectable()
export class ProposalStateService {
  private readonly proposals = new Map<string, PlanningMutationProposal>();
  private readonly memoryChanges = new Map<string, PlanningMemoryChange>();
  private readonly githubSyncs = new Map<string, GitHubSyncProposal>();
  private readonly issueIdAliases = new Map<string, string>();

  private activeProposalId: string | null = null;
  private proposalCounter = 0;
  private lastCommitResult: PlanningGraphCommitResult | null = null;
  private activeMemoryChangeId: string | null = null;
  private lastMemoryWriteResult: PlanningMemoryWriteResult | null = null;
  private activeGitHubSyncId: string | null = null;
  private lastGitHubSyncResult: GitHubSyncResult | null = null;

  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
    @Inject(MemoryService) private readonly memoryService: MemoryService,
  ) {}

  // ─── Proposal staging ────────────────────────────────────────────

  setActiveProposal(proposal: PlanningMutationProposal): void {
    this.proposals.set(proposal.proposal_id, proposal);
    this.activeProposalId = proposal.proposal_id;
    this.lastCommitResult = null;
  }

  getActiveProposal(): PlanningMutationProposal | null {
    return this.activeProposalId ? this.proposals.get(this.activeProposalId) ?? null : null;
  }

  getProposal(proposalId: string): PlanningMutationProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  /**
   * Return the active proposal only if it was created in the current
   * turn and has not yet been committed — suitable for accumulating
   * additional mutations from a second `github_create_issue` call in
   * the same turn.
   */
  getActiveProposalForAccumulation(currentTurnId: string | null): PlanningMutationProposal | null {
    const proposal = this.getActiveProposal();
    if (!proposal || !currentTurnId) {
      return null;
    }
    if (proposal.source.turn_id !== currentTurnId) {
      return null;
    }
    return proposal;
  }

  setLastCommitResult(result: PlanningGraphCommitResult | null): void {
    this.lastCommitResult = result;
  }

  getLastCommitResult(): PlanningGraphCommitResult | null {
    return this.lastCommitResult;
  }

  updateActiveProposalAfterApply(
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

  normalizeProposal(
    input: ProposeMutationsToolInput,
    defaults: { currentTurnId: string | null; sessionId: string },
  ): PlanningMutationProposal {
    const graphVersion = input.context?.based_on_graph_version ?? this.graphService.getGraph().graph_version;
    const proposalId = input.proposal_id?.trim() || `prop_${Date.now()}_${++this.proposalCounter}`;
    const createdAt = input.created_at?.trim() || this.now();

    return {
      proposal_id: proposalId,
      created_at: createdAt,
      source: {
        agent: input.source?.agent?.trim() || "root-planner",
        turn_id: input.source?.turn_id?.trim() || defaults.currentTurnId,
        session_id: input.source?.session_id?.trim() || defaults.sessionId,
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

  /**
   * Append new mutations to an existing proposal, re-numbering their
   * IDs to avoid collisions. Returns the updated (same-ID) proposal.
   */
  accumulateMutations(
    existing: PlanningMutationProposal,
    newMutations: ProposeMutationsToolInput["mutations"],
    summaryAppendix: string,
  ): PlanningMutationProposal {
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

  rememberIssueIdAlias(
    requestedId: string | null | undefined,
    finalId: string,
    stagedWorkItemIds: ReadonlySet<string> = new Set(),
  ): void {
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

  resolveIssueIdAlias(id: string | null | undefined, stopIds: ReadonlySet<string> = new Set()): string {
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

  getStagedWorkItemIds(proposal: PlanningMutationProposal | null | undefined): Set<string> {
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

  rewriteProposalIssueAliases(proposal: PlanningMutationProposal): PlanningMutationProposal {
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

  // ─── Memory change staging ───────────────────────────────────────

  setActiveMemoryChange(change: PlanningMemoryChange): void {
    this.memoryChanges.set(change.change_id, change);
    this.activeMemoryChangeId = change.change_id;
    this.lastMemoryWriteResult = null;
  }

  getActiveMemoryChange(): PlanningMemoryChange | null {
    return this.activeMemoryChangeId ? this.memoryChanges.get(this.activeMemoryChangeId) ?? null : null;
  }

  getMemoryChange(changeId: string): PlanningMemoryChange | null {
    return this.memoryChanges.get(changeId) ?? null;
  }

  setLastMemoryWriteResult(result: PlanningMemoryWriteResult | null): void {
    this.lastMemoryWriteResult = result;
  }

  getLastMemoryWriteResult(): PlanningMemoryWriteResult | null {
    return this.lastMemoryWriteResult;
  }

  updateActiveMemoryChangeAfterApply(
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

  normalizeMemoryChange(
    input: ProposeMemoryWriteToolInput,
    defaults: { currentTurnId: string | null; sessionId: string },
  ): PlanningMemoryChange {
    const memory = this.memoryService.read();
    const changeId = input.change_id?.trim() || `mem_${Date.now()}`;
    const createdAt = input.created_at?.trim() || this.now();

    return {
      change_id: changeId,
      created_at: createdAt,
      source: {
        agent: input.source?.agent?.trim() || "root-planner",
        turn_id: input.source?.turn_id?.trim() || defaults.currentTurnId,
        session_id: input.source?.session_id?.trim() || defaults.sessionId,
      },
      summary: input.summary.trim(),
      based_on_content_hash: memory.content_hash,
      edits: input.edits.map((edit, index) => this.normalizeMemoryEdit(edit, index)),
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

  // ─── GitHub sync staging ─────────────────────────────────────────

  setActiveGitHubSync(sync: GitHubSyncProposal): void {
    this.githubSyncs.set(sync.sync_id, sync);
    this.activeGitHubSyncId = sync.sync_id;
    this.lastGitHubSyncResult = null;
  }

  getActiveGitHubSync(): GitHubSyncProposal | null {
    return this.activeGitHubSyncId ? this.githubSyncs.get(this.activeGitHubSyncId) ?? null : null;
  }

  getGitHubSync(syncId: string): GitHubSyncProposal | null {
    return this.githubSyncs.get(syncId) ?? null;
  }

  setLastGitHubSyncResult(result: GitHubSyncResult | null): void {
    this.lastGitHubSyncResult = result;
  }

  getLastGitHubSyncResult(): GitHubSyncResult | null {
    return this.lastGitHubSyncResult;
  }

  updateActiveGitHubSyncAfterApply(
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

  async normalizeGitHubSync(
    input: GitHubSyncToolInput,
    defaults: { currentTurnId: string | null; sessionId: string },
  ): Promise<GitHubSyncProposal> {
    const staged = await this.githubService.stageManagedBlockSync(input.work_item_id);
    return {
      sync_id: input.sync_id?.trim() || `ghsync_${Date.now()}`,
      created_at: input.created_at?.trim() || this.now(),
      source: {
        agent: input.source?.agent?.trim() || "root-planner",
        turn_id: input.source?.turn_id?.trim() || defaults.currentTurnId,
        session_id: input.source?.session_id?.trim() || defaults.sessionId,
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

  // ─── Turn lifecycle + dismiss ────────────────────────────────────

  /**
   * Clear issue ID aliases between turn boundaries. Called by
   * `PlanningService.handleSessionEvent` at `turn_start` and
   * `turn_end` so aliases from a previous turn don't leak into the
   * next one.
   */
  resetTurnState(): void {
    this.issueIdAliases.clear();
  }

  dismissAll(): {
    dismissed_proposal_ids: string[];
    dismissed_memory_change_ids: string[];
    dismissed_github_sync_ids: string[];
  } {
    const dismissedProposalIds = this.activeProposalId ? [this.activeProposalId] : [];
    const dismissedMemoryChangeIds = this.activeMemoryChangeId ? [this.activeMemoryChangeId] : [];
    const dismissedGitHubSyncIds = this.activeGitHubSyncId ? [this.activeGitHubSyncId] : [];

    this.activeProposalId = null;
    this.lastCommitResult = null;
    this.activeMemoryChangeId = null;
    this.lastMemoryWriteResult = null;
    this.activeGitHubSyncId = null;
    this.lastGitHubSyncResult = null;

    return {
      dismissed_proposal_ids: dismissedProposalIds,
      dismissed_memory_change_ids: dismissedMemoryChangeIds,
      dismissed_github_sync_ids: dismissedGitHubSyncIds,
    };
  }

  // ─── Trivial helpers ─────────────────────────────────────────────

  private now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}
