import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DelegateSubAgentToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createDelegateSubAgentTool(deps: PlanningToolDeps) {
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
      const run = await deps.subAgentService.runDelegation(params, {
        onStatus: (nextRun) => deps.emitStudioEvent("subagent_status", { run: nextRun }),
        onResult: (nextRun) => deps.emitStudioEvent("subagent_result", { run: nextRun }),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(run.result ?? run, null, 2) }],
        details: { run },
      };
    },
  });
}
