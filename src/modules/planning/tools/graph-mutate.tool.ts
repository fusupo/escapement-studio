import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ApproveMutationProposalDto } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

/**
 * V1: direct graph_mutate execution is disabled. Browser approval is
 * required for every commit. The tool exists only as a no-op
 * placeholder so the LLM can still reason about graph commits in its
 * response — it never actually mutates anything.
 */
export function createGraphMutateTool(_deps: PlanningToolDeps) {
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
