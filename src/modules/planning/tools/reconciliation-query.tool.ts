import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { ReconciliationQueryToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createReconciliationQueryTool(deps: PlanningToolDeps) {
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
        ? deps.reconciliationService.getReport(params.work_item_id)
        : deps.reconciliationService.listReports();

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
