import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { GitHubReadToolInput } from "../types.js";
import type { PlanningToolDeps } from "./types.js";

export function createGitHubReadTool(deps: PlanningToolDeps) {
  return defineTool({
    name: "github_read",
    label: "GitHub Read",
    description: "Read GitHub issue details for an issue-backed work item or repo issue.",
    promptSnippet: "github_read: inspect GitHub issue details before making GitHub sync recommendations.",
    promptGuidelines: [
      "Use github_read when you need grounded issue details from GitHub rather than relying only on graph metadata.",
      "Prefer the work item's repo + issue_number when available.",
    ],
    parameters: Type.Object({
      repo: Type.String(),
      issue_number: Type.Number(),
    }),
    execute: async (_toolCallId, params: GitHubReadToolInput) => {
      const issue = await deps.githubService.readIssue(params.repo, params.issue_number);
      return {
        content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });
}
