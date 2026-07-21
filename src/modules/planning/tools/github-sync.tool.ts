import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { GitHubSyncToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createGitHubSyncTool(deps: PlanningToolDeps) {
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
      const sync = await deps.proposalState.normalizeGitHubSync(params, deps.buildProposalDefaults());
      deps.proposalState.setActiveGitHubSync(sync);
      deps.emitStudioEvent("github_sync_proposal", { sync });

      return {
        content: [{ type: "text", text: `Staged GitHub sync ${sync.sync_id} with ${sync.operations.length} operation(s).` }],
        details: { sync },
      };
    },
  });
}
