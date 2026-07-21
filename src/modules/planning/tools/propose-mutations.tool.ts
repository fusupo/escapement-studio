import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ProposeMutationsToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createProposeMutationsTool(deps: PlanningToolDeps) {
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
      const proposal = deps.proposalState.normalizeProposal(params, deps.buildProposalDefaults());
      deps.proposalState.setActiveProposal(proposal);
      deps.emitStudioEvent("mutation_proposal", { proposal });

      return {
        content: [{ type: "text", text: `Staged proposal ${proposal.proposal_id} with ${proposal.mutations.length} mutation(s).` }],
        details: { proposal },
      };
    },
  });
}
