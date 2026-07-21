import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ProposeMemoryWriteToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createMemoryWriteTool(deps: PlanningToolDeps) {
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
      const change = deps.proposalState.normalizeMemoryChange(params, deps.buildProposalDefaults());
      deps.proposalState.setActiveMemoryChange(change);
      deps.emitStudioEvent("memory_change_proposal", { change });

      return {
        content: [{ type: "text", text: `Staged planning memory change ${change.change_id} with ${change.edits.length} edit(s).` }],
        details: { change },
      };
    },
  });
}
