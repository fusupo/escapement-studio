import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../graph/graph.service.js", () => ({
  GraphService: class {},
}));

vi.mock("../../graph/graph-writer.service.js", () => ({
  GraphWriterService: class {},
}));

vi.mock("../../github/github.service.js", () => ({
  GitHubService: class {},
}));

vi.mock("../context.service.js", () => ({
  ContextService: class {},
}));

vi.mock("../memory.service.js", () => ({
  MemoryService: class {},
}));

vi.mock("../sub-agent.service.js", () => ({
  SubAgentService: class {},
}));

vi.mock("../../reconciliation/reconciliation.service.js", () => ({
  ReconciliationService: class {},
}));

import { PlanningService } from "../planning.service.js";
import type { PlanningMutationProposal } from "../types.js";

type CreatedIssue = {
  repo: string;
  number: number;
  url: string;
  title: string;
};

function makePlanningService(createdIssues: CreatedIssue[]) {
  const createIssue = vi.fn<(input: { repo: string; title: string; body?: string; labels?: string[] }) => Promise<CreatedIssue>>();
  for (const issue of createdIssues) {
    createIssue.mockResolvedValueOnce(issue);
  }

  const service = new PlanningService(
    {} as never,
    { getGraph: () => ({ graph_version: "7" }) } as never,
    {} as never,
    {} as never,
    {} as never,
    { createIssue } as never,
    {} as never,
  );

  (service as any).currentTurnId = "turn_0001";

  return {
    service,
    createIssue,
    tool: (service as any).createGitHubCreateIssueTool(),
  };
}

async function executeCreateIssue(
  tool: any,
  params: Record<string, unknown>,
): Promise<PlanningMutationProposal> {
  const result = await tool.execute("tool_call_1", params, undefined, undefined, {} as never);
  return result.details.proposal as PlanningMutationProposal;
}

function getCreateWorkItemIds(proposal: PlanningMutationProposal): string[] {
  return proposal.mutations
    .filter((mutation) => mutation.type === "create_work_item")
    .map((mutation) => mutation.entity_id ?? "");
}

function getEdge(
  proposal: PlanningMutationProposal,
  rel: "is_part_of" | "depends_on",
): { from_id: string; to_id: string } {
  const mutation = proposal.mutations.find((candidate) => candidate.type === "create_edge" && candidate.payload?.rel === rel);
  expect(mutation).toBeDefined();
  return {
    from_id: String(mutation?.payload?.from_id),
    to_id: String(mutation?.payload?.to_id),
  };
}

describe("PlanningService github_create_issue staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("canonicalizes staged issue-backed IDs to the actual GitHub issue number", async () => {
    const { tool } = makePlanningService([
      {
        repo: "fusupo/escapement-studio",
        number: 83,
        url: "https://github.com/fusupo/escapement-studio/issues/83",
        title: "Epic",
      },
    ]);

    const proposal = await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Epic",
      work_item_id: "studio-82",
    });

    expect(getCreateWorkItemIds(proposal)).toEqual(["studio-83"]);
    expect(proposal.mutations[0].payload?.id).toBe("studio-83");
    expect(proposal.mutations[0].payload?.issue_number).toBe(83);
    expect(JSON.stringify(proposal)).not.toContain("studio-82");
  });

  it("rewrites epic-child parent references from placeholder IDs to the final canonical parent ID", async () => {
    const { tool } = makePlanningService([
      {
        repo: "fusupo/escapement-studio",
        number: 83,
        url: "https://github.com/fusupo/escapement-studio/issues/83",
        title: "Epic",
      },
      {
        repo: "fusupo/escapement-studio",
        number: 84,
        url: "https://github.com/fusupo/escapement-studio/issues/84",
        title: "Child",
      },
    ]);

    await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Epic",
      work_item_id: "studio-82",
    });

    const proposal = await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Child",
      work_item_id: "studio-83",
      parent_id: "studio-82",
    });

    expect(getCreateWorkItemIds(proposal)).toEqual(["studio-83", "studio-84"]);
    expect(getEdge(proposal, "is_part_of")).toEqual({
      from_id: "studio-84",
      to_id: "studio-83",
    });
    expect(JSON.stringify(proposal)).not.toContain('"studio-82"');
  });

  it("rewrites depends_on references to the final canonical ID in grouped issue flows", async () => {
    const { tool } = makePlanningService([
      {
        repo: "fusupo/escapement-studio",
        number: 91,
        url: "https://github.com/fusupo/escapement-studio/issues/91",
        title: "Dependency",
      },
      {
        repo: "fusupo/escapement-studio",
        number: 92,
        url: "https://github.com/fusupo/escapement-studio/issues/92",
        title: "Blocked issue",
      },
    ]);

    await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Dependency",
      work_item_id: "studio-90",
    });

    const proposal = await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Blocked issue",
      work_item_id: "studio-91",
      depends_on_ids: ["studio-90"],
    });

    expect(getEdge(proposal, "depends_on")).toEqual({
      from_id: "studio-92",
      to_id: "studio-91",
    });
    expect(JSON.stringify(proposal)).not.toContain('"studio-90"');
  });

  it("rewrites previously accumulated child references when a later issue creation resolves the placeholder parent ID", async () => {
    const { tool } = makePlanningService([
      {
        repo: "fusupo/escapement-studio",
        number: 84,
        url: "https://github.com/fusupo/escapement-studio/issues/84",
        title: "Child",
      },
      {
        repo: "fusupo/escapement-studio",
        number: 83,
        url: "https://github.com/fusupo/escapement-studio/issues/83",
        title: "Epic",
      },
    ]);

    await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Child",
      work_item_id: "studio-83",
      parent_id: "studio-82",
    });

    const proposal = await executeCreateIssue(tool, {
      repo: "fusupo/escapement-studio",
      title: "Epic",
      work_item_id: "studio-82",
    });

    expect(getCreateWorkItemIds(proposal)).toEqual(["studio-84", "studio-83"]);
    expect(getEdge(proposal, "is_part_of")).toEqual({
      from_id: "studio-84",
      to_id: "studio-83",
    });
    expect(JSON.stringify(proposal)).not.toContain('"studio-82"');
  });
});
