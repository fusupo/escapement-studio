import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { GraphQueryToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createGraphQueryTool(deps: PlanningToolDeps) {
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
        ? deps.graphService.getGraph({
            repo: params.repo,
            state: params.state,
            track: params.track,
            phase: params.phase,
          })
        : params.query === "frontier"
          ? deps.graphService.getFrontier(params.repo)
          : deps.graphService.getPlan(params.repo);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
