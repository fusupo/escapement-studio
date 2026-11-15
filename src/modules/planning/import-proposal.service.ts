import { BadGatewayException, BadRequestException, Inject, Injectable } from "@nestjs/common";
import { GitHubItemLookup } from "../github/github-item-lookup.service.js";
import { parseIssueReferences, type IssueReference } from "../github/issue-reference-parser.js";
import { UntrackedIssuesService, type UntrackedIssue } from "../github/untracked-issues.service.js";
import { GraphWriterService } from "../graph/graph-writer.service.js";
import type { CreateEdgeDto, EdgeRel, ValidateGraphMutationsResult } from "../graph/types.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { buildIssueNodeMutation, issueGroupId, type ProposedMutation } from "./issue-node-mutation.js";
import { PlanningService } from "./planning.service.js";
import { toGraphMutation } from "./proposal-graph-mutation.js";
import { ProposalStateService } from "./proposal-state.service.js";
import type { PlanningMutationProposal } from "./types.js";

export const MAX_IMPORT_BATCH = 50;
const SCOPE_HINT_LIMIT = 160;

export interface ImportIssuesDto {
  repo: string;
  issue_numbers: number[];
}

/** One statement in an issue body that supports a proposed edge. */
export interface EdgeEvidence {
  source: "issue_body";
  issue: string;
  quote: string;
}

/** A relationship an issue states whose target is not in the graph or the batch; no edge is proposed. */
export interface UnresolvedReference {
  rel: EdgeRel;
  direction: IssueReference["direction"];
  target: string;
  quote: string;
}

export interface ImportProposalResult {
  proposal: PlanningMutationProposal;
  /** Outcome of validating the whole proposal against the current graph. */
  validation: ValidateGraphMutationsResult;
}

/**
 * Builds the reviewable proposal for importing untracked GitHub issues
 * (#281): one `create_work_item` per issue plus the edges its body
 * states explicitly. Nothing is written to the graph here; the proposal
 * is staged for the same review and atomic apply as planner proposals.
 *
 * Edges come only from text the issue author wrote (`issue_body`
 * evidence, confidence "certain"). A reference that resolves to nothing
 * is reported on the node, not turned into an edge, and an issue with
 * no resolvable reference is imported unconnected.
 */
@Injectable()
export class ImportProposalService {
  constructor(
    @Inject(UntrackedIssuesService) private readonly untracked: UntrackedIssuesService,
    @Inject(GitHubItemLookup) private readonly lookup: GitHubItemLookup,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
    @Inject(ProposalStateService) private readonly proposalState: ProposalStateService,
    @Inject(PlanningService) private readonly planning: PlanningService,
  ) {}

  async stage(input: ImportIssuesDto): Promise<ImportProposalResult> {
    const numbers = this.requireIssueNumbers(input?.issue_numbers);
    const discovery = await this.untracked.list(input?.repo);
    const repo = discovery.repo;
    const candidates = new Map(discovery.candidates.map((candidate) => [candidate.issue_number, candidate]));

    const selected: UntrackedIssue[] = numbers.map((number) => {
      const candidate = candidates.get(number);
      if (!candidate) {
        throw new BadRequestException(`${repo}#${number} is not an open, untracked issue (already imported, closed, or missing)`);
      }
      if (candidate.conflict) throw new BadRequestException(`${repo}#${number} cannot be imported: ${candidate.conflict}`);
      return candidate;
    });

    const bodies = await Promise.all(selected.map((candidate) =>
      this.lookup.issueWithBody(repo, candidate.issue_number).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new BadGatewayException(`Could not read ${repo}#${candidate.issue_number} from GitHub: ${reason}`);
      })));

    const batchIds = new Map(selected.map((candidate) => [candidate.issue_number, candidate.derived_id]));
    const existingIds = new Set(this.workItems.list().map((item) => item.id));
    const edges = new Map<string, { group: string; edge: CreateEdgeDto; evidence: EdgeEvidence[] }>();
    const nodes: ProposedMutation[] = [];

    selected.forEach((candidate, index) => {
      const issue = bodies[index];
      const unresolved: UnresolvedReference[] = [];
      for (const reference of parseIssueReferences(issue.body, repo)) {
        const targetId = this.resolveTarget(reference, repo, batchIds, existingIds);
        if (targetId === candidate.derived_id) continue;
        if (!targetId) {
          unresolved.push({
            rel: reference.rel,
            direction: reference.direction,
            target: reference.work_item_id ?? `${reference.repo}#${reference.issue_number}`,
            quote: reference.quote,
          });
          continue;
        }
        const [fromId, toId] = reference.direction === "outgoing" ? [candidate.derived_id, targetId] : [targetId, candidate.derived_id];
        const key = `${fromId}|${reference.rel}|${toId}`;
        const evidence: EdgeEvidence = { source: "issue_body", issue: `${repo}#${candidate.issue_number}`, quote: reference.quote };
        const known = edges.get(key);
        if (known) known.evidence.push(evidence);
        else {
          edges.set(key, {
            group: issueGroupId(candidate.issue_number),
            edge: { from_id: fromId, rel: reference.rel, to_id: toId, confidence: "certain" },
            evidence: [evidence],
          });
        }
      }

      nodes.push(buildIssueNodeMutation({
        id: `n${candidate.issue_number}`,
        workItemId: candidate.derived_id,
        repo,
        issueNumber: candidate.issue_number,
        issueUrl: candidate.issue_url,
        title: issue.title || candidate.title,
        scopeHint: scopeHint(issue.body),
        rationale: `Import untracked GitHub issue ${repo}#${candidate.issue_number}.`,
        validation: unresolved.length > 0 ? { unresolved_references: unresolved } : undefined,
      }));
    });

    const nodeMutationIds = new Map(nodes.map((node) => [node.entity_id as string, node.id as string]));
    const edgeMutations: ProposedMutation[] = [...edges.values()].map((entry, index) => ({
      id: `e${index + 1}`,
      type: "create_edge",
      group_id: entry.group,
      payload: { ...entry.edge, meta: { evidence: entry.evidence } },
      rationale: `Stated in ${entry.evidence.map((evidence) => `${evidence.issue}: "${evidence.quote}"`).join("; ")}`,
      depends_on_mutation_ids: [entry.edge.from_id, entry.edge.to_id]
        .map((id) => nodeMutationIds.get(id))
        .filter((id): id is string => Boolean(id)),
    }));

    const proposal = this.proposalState.normalizeProposal({
      source: { agent: "issue-import", turn_id: null },
      context: { scope: `import:${repo}` },
      summary: `Import ${selected.length} GitHub issue${selected.length === 1 ? "" : "s"} from ${repo}: ${numbers.map((number) => `#${number}`).join(", ")}`,
      mutations: [...nodes, ...edgeMutations],
    }, { currentTurnId: null, sessionId: "issue-import" });

    const validation = this.graphWriter.validate({
      proposal_id: proposal.proposal_id,
      based_on_graph_version: proposal.context?.based_on_graph_version,
      mutations: proposal.mutations.map((mutation) => toGraphMutation(mutation)),
    });
    if (validation.status === "validation_failed") {
      for (const mutation of proposal.mutations) {
        const errors = validation.errors.filter((error) => error.mutation_id === mutation.id);
        if (errors.length > 0) mutation.validation = { ...mutation.validation, errors };
      }
    }

    this.planning.stageProposal(proposal);
    return { proposal, validation };
  }

  private requireIssueNumbers(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new BadRequestException("issue_numbers must list at least one issue");
    }
    const numbers = [...new Set(value)];
    if (numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
      throw new BadRequestException("issue_numbers must be positive integers");
    }
    if (numbers.length > MAX_IMPORT_BATCH) {
      throw new BadRequestException(`At most ${MAX_IMPORT_BATCH} issues can be imported at once`);
    }
    return (numbers as number[]).sort((left, right) => left - right);
  }

  /** The work item a reference points at: one in this batch, or one already in the graph. */
  private resolveTarget(
    reference: IssueReference,
    repo: string,
    batchIds: Map<number, string>,
    existingIds: Set<string>,
  ): string | null {
    if (reference.work_item_id) {
      const id = reference.work_item_id;
      return existingIds.has(id) || [...batchIds.values()].includes(id) ? id : null;
    }
    if (!reference.repo || reference.issue_number == null) return null;
    if (reference.repo.toLowerCase() === repo.toLowerCase()) {
      const inBatch = batchIds.get(reference.issue_number);
      if (inBatch) return inBatch;
    }
    const slug = this.untracked.findIncludedRepo(reference.repo) ?? reference.repo;
    return this.workItems.listByRepoIssueNumber(slug, reference.issue_number)[0]?.id ?? null;
  }
}

/** First line of prose in the body, as a one-line scope hint; null when there is none. */
export function scopeHint(body: string | null | undefined): string | null {
  let fenced = false;
  for (const raw of `${body ?? ""}`.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*(#|<!--|[-*]\s+\[[ xX]\]|\||---)/.test(raw)) continue;
    const line = raw.replace(/^\s*(?:[-*>]|\d+\.)\s+/, "").replace(/[*`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
    if (line.length < 3) continue;
    return line.length > SCOPE_HINT_LIMIT ? `${line.slice(0, SCOPE_HINT_LIMIT - 1)}…` : line;
  }
  return null;
}
