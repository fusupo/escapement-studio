import { createDelegateSubAgentTool } from "./delegate-subagent.tool.js";
import { createGitHubCreateIssueTool } from "./github-create-issue.tool.js";
import { createGitHubReadTool } from "./github-read.tool.js";
import { createGitHubSyncTool } from "./github-sync.tool.js";
import { createGraphMutateTool } from "./graph-mutate.tool.js";
import { createGraphQueryTool } from "./graph-query.tool.js";
import { createMemoryReadTool } from "./memory-read.tool.js";
import { createMemoryWriteTool } from "./memory-write.tool.js";
import { createProposeMutationsTool } from "./propose-mutations.tool.js";
import { createReconciliationQueryTool } from "./reconciliation-query.tool.js";
import type { PlanningToolDeps } from "./types.js";

/**
 * Phase 7 (#227): central registry returning all 10 root-planner
 * custom tools in their original registration order. Tool names are
 * a hard contract — preserved exactly so the LLM's memorised tool
 * set keeps working.
 */
export function createPlanningTools(deps: PlanningToolDeps) {
  return [
    createGraphQueryTool(deps),
    createProposeMutationsTool(deps),
    createGraphMutateTool(deps),
    createMemoryReadTool(deps),
    createMemoryWriteTool(deps),
    createDelegateSubAgentTool(deps),
    createGitHubReadTool(deps),
    createGitHubCreateIssueTool(deps),
    createGitHubSyncTool(deps),
    createReconciliationQueryTool(deps),
  ];
}
