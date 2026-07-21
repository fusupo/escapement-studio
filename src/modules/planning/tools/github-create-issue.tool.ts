import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  deriveIssueWorkItemId,
  type CreateEdgeDto,
  type CreateWorkItemDto,
} from "../../graph/types.js";
import type {
  GitHubCreateIssueToolInput,
  PlanningMutationProposal,
  ProposeMutationsToolInput,
} from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createGitHubCreateIssueTool(deps: PlanningToolDeps) {
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
      const created = await deps.githubService.createIssue({
        repo: params.repo,
        title: params.title,
        body: params.body,
        labels: params.labels,
      });

      const existingProposal = deps.proposalState.getActiveProposalForAccumulation(deps.getCurrentTurnId());
      const stagedWorkItemIds = deps.proposalState.getStagedWorkItemIds(existingProposal);
      const requestedWorkItemId = params.work_item_id?.trim();
      const workItemId = deriveIssueWorkItemId(created.number);
      deps.proposalState.rememberIssueIdAlias(requestedWorkItemId, workItemId, stagedWorkItemIds);

      const groupId = `issue-${created.number}`;
      const parentId = deps.proposalState.resolveIssueIdAlias(params.parent_id, stagedWorkItemIds);
      const dependsOnIds = params.depends_on_ids
        ?.map((depId) => deps.proposalState.resolveIssueIdAlias(depId, stagedWorkItemIds))
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
          } satisfies CreateWorkItemDto,
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
          } satisfies CreateEdgeDto,
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
            } satisfies CreateEdgeDto,
            rationale: `${workItemId} depends on ${depId}.`,
          });
        }
      }

      // Accumulate into existing active proposal from the same turn,
      // so multi-issue creation produces one reviewable proposal.
      let proposal: PlanningMutationProposal;

      if (existingProposal) {
        proposal = deps.proposalState.accumulateMutations(
          existingProposal,
          mutations,
          `+ GitHub issue #${created.number}: ${created.title}`,
        );
      } else {
        proposal = deps.proposalState.normalizeProposal({
          summary: `Graph work item for GitHub issue #${created.number}: ${created.title}`,
          mutations,
        }, deps.buildProposalDefaults());
      }

      proposal = deps.proposalState.rewriteProposalIssueAliases(proposal);

      deps.proposalState.setActiveProposal(proposal);
      deps.emitStudioEvent("mutation_proposal", { proposal });

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
