import type { CreateWorkItemDto } from "../graph/types.js";
import type { ProposeMutationsToolInput } from "./types.js";

export type ProposedMutation = ProposeMutationsToolInput["mutations"][number];

/** Proposal group that holds one issue's node and the edges stated for it. */
export function issueGroupId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/**
 * The `create_work_item` proposal mutation for an issue-backed node.
 * Shared by `github_create_issue` (an issue Studio just created) and
 * the import of an issue that already exists (#281), so both stage the
 * same node: kind "issue", state "planned".
 */
export function buildIssueNodeMutation(input: {
  id?: string;
  workItemId: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  scopeHint?: string | null;
  predictedFiles?: string[];
  rationale: string;
  validation?: Record<string, unknown>;
}): ProposedMutation {
  return {
    ...(input.id ? { id: input.id } : {}),
    type: "create_work_item",
    entity_id: input.workItemId,
    group_id: issueGroupId(input.issueNumber),
    payload: {
      id: input.workItemId,
      name: input.title,
      kind: "issue",
      state: "planned",
      repo: input.repo,
      issue_number: input.issueNumber,
      issue_url: input.issueUrl,
      scope_hint: input.scopeHint ?? null,
      predicted_files: input.predictedFiles ?? [],
    } satisfies CreateWorkItemDto,
    rationale: input.rationale,
    ...(input.validation ? { validation: input.validation } : {}),
  };
}
