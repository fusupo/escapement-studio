import { BadGatewayException, BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { initManifest } from "../../../lib/manifest-core.js";
import { SQLiteService } from "../../../platform/sqlite.service.js";
import { UntrackedIssuesService } from "../../github/untracked-issues.service.js";
import { GraphWriterService } from "../../graph/graph-writer.service.js";
import type { GraphMutationsValidationFailedResult } from "../../graph/types.js";
import { WorkItemsService } from "../../graph/work-items.service.js";
import { ImportProposalService, scopeHint } from "../import-proposal.service.js";
import { PlanningService } from "../planning.service.js";
import { ProposalStateService } from "../proposal-state.service.js";

const STUDIO = "fusupo/escapement-studio";
const SPIRAL = "corpus-relica/spiral-time";

/**
 * Real in-memory graph (SQLite, GraphWriter, WorkItemsService), real
 * discovery, proposal state and PlanningService approval; only GitHub
 * and the event stream are stubbed.
 */
function setup(bodies: Record<number, string>, repo = STUDIO) {
  const db = initManifest(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS studio_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO studio_metadata (key, value) VALUES ('graph_version', '0');`);
  const sqlite = Object.create(SQLiteService.prototype) as SQLiteService;
  Object.defineProperty(sqlite, "db", { value: db });
  (sqlite as unknown as { initializeStudioMetadata: () => void }).initializeStudioMetadata();

  const seed = db.prepare(
    `INSERT INTO work_items (id, name, kind, state, repo, issue_number, predicted_files, actual_files, meta)
     VALUES (?, ?, 'issue', 'planned', ?, ?, '[]', '[]', '{}')`,
  );
  seed.run("studio-10", "Ten", STUDIO, 10);
  seed.run("studio-11", "Eleven", STUDIO, 11);
  db.prepare("INSERT INTO edges (from_id, rel, to_id, confidence, meta) VALUES ('studio-10', 'depends_on', 'studio-11', 'certain', '{}')").run();

  const writer = new GraphWriterService(sqlite);
  const workItems = new WorkItemsService(sqlite, writer);
  const numbers = Object.keys(bodies).map(Number);
  const cache = {
    listIssues: vi.fn(async () => new Map([10, 11, ...numbers].map((number) => [number, {
      number, state: "open" as const, closed_at: null, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`,
    }]))),
    invalidate: vi.fn(),
  };
  const untracked = new UntrackedIssuesService(cache as never, workItems, { listIncludedRepos: () => [STUDIO, SPIRAL] } as never);
  const lookup = {
    issueWithBody: vi.fn(async (_repo: string, number: number) => ({
      number, state: "open" as const, closed_at: null, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`, body: bodies[number],
    })),
  };
  const graphService = { getGraph: () => ({ graph_version: sqlite.getGraphVersion() }) } as never;
  const proposalState = new ProposalStateService(graphService, {} as never, {} as never);
  const planning = new PlanningService({} as never, graphService, writer, {} as never, {} as never, {} as never, {} as never, {} as never, proposalState);
  const emitted: Array<{ type: string; payload: any }> = [];
  (planning as any).emitStudioEvent = (type: string, payload: unknown) => { emitted.push({ type, payload }); };

  const service = new ImportProposalService(untracked, lookup as never, workItems, writer, proposalState, planning);
  const edges = () => db.prepare("SELECT from_id, rel, to_id, confidence, meta FROM edges ORDER BY id").all() as Array<Record<string, string>>;
  const itemIds = () => (db.prepare("SELECT id FROM work_items ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
  return { service, planning, proposalState, lookup, emitted, sqlite, edges, itemIds, repo };
}

const brief = (proposal: { mutations: Array<{ id: string; type: string; entity_id?: string }> }) =>
  proposal.mutations.map((mutation) => `${mutation.id} ${mutation.type} ${mutation.entity_id}`);

describe("ImportProposalService (#281)", () => {
  it("stages one proposal with a node per issue and the edges their bodies state", async () => {
    const ctx = setup({
      20: "Adds the importer.\n\nDepends on #10 and #21.\nPart of #11",
      21: "## Summary\nGroundwork for the importer.",
    });

    const { proposal, validation } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [21, 20, 20] });

    expect(validation.status).toBe("valid");
    expect(brief(proposal)).toEqual([
      "n20 create_work_item studio-20",
      "n21 create_work_item studio-21",
      "e1 create_edge studio-20:depends_on:studio-10",
      "e2 create_edge studio-20:depends_on:studio-21",
      "e3 create_edge studio-20:is_part_of:studio-11",
    ]);
    expect(proposal.mutations[0]).toMatchObject({
      group_id: "issue-20",
      payload: {
        id: "studio-20", name: "Issue 20", kind: "issue", state: "planned", repo: STUDIO, issue_number: 20,
        issue_url: `https://github.com/${STUDIO}/issues/20`, scope_hint: "Adds the importer.", predicted_files: [],
      },
    });
    expect(proposal.mutations[3]).toMatchObject({
      group_id: "issue-20",
      depends_on_mutation_ids: ["n20", "n21"],
      payload: {
        confidence: "certain",
        meta: { evidence: [{ source: "issue_body", issue: `${STUDIO}#20`, quote: "Depends on #10 and #21." }] },
      },
      rationale: `Stated in ${STUDIO}#20: "Depends on #10 and #21."`,
    });
    expect(proposal.source).toMatchObject({ agent: "issue-import", turn_id: null });
    expect(proposal.context).toEqual({ scope: `import:${STUDIO}`, based_on_graph_version: "0" });
    expect(proposal.summary).toBe(`Import 2 GitHub issues from ${STUDIO}: #20, #21`);
  });

  it("makes the proposal active and announces it, without touching the graph", async () => {
    const ctx = setup({ 20: "Depends on #10" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });

    expect(ctx.proposalState.getActiveProposal()).toBe(proposal);
    expect(ctx.emitted).toEqual([{ type: "mutation_proposal", payload: { proposal } }]);
    expect(ctx.itemIds()).toEqual(["studio-10", "studio-11"]);
    expect(ctx.sqlite.getGraphVersion()).toBe("0");
  });

  it("imports an issue unconnected when it states no resolvable relationship", async () => {
    const ctx = setup({ 20: "See #10 for background.\nDepends on #999 and nothing-77.\nBlocks other/repo#3" });
    const { proposal, validation } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });

    expect(validation.status).toBe("valid");
    expect(brief(proposal)).toEqual(["n20 create_work_item studio-20"]);
    expect(proposal.mutations[0].validation).toEqual({ unresolved_references: [
      { rel: "depends_on", direction: "outgoing", target: `${STUDIO}#999`, quote: "Depends on #999 and nothing-77." },
      { rel: "depends_on", direction: "outgoing", target: "nothing-77", quote: "Depends on #999 and nothing-77." },
      { rel: "depends_on", direction: "incoming", target: "other/repo#3", quote: "Blocks other/repo#3" },
    ] });
  });

  it("resolves incoming references, literal work-item IDs, and merges two statements of one edge", async () => {
    const ctx = setup({
      20: "Blocks #10\n- [ ] #21\ndepends on studio-11\nself: depends on #20",
      21: "Part of #20",
    });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20, 21] });

    expect(brief(proposal).slice(2)).toEqual([
      "e1 create_edge studio-10:depends_on:studio-20",
      "e2 create_edge studio-21:is_part_of:studio-20",
      "e3 create_edge studio-20:depends_on:studio-11",
    ]);
    const merged = proposal.mutations[3].payload as { meta: { evidence: Array<{ issue: string }> } };
    expect(merged.meta.evidence.map((evidence) => evidence.issue)).toEqual([`${STUDIO}#20`, `${STUDIO}#21`]);
  });

  it("gives another repo's issues their own ID prefix and keeps bare #N inside that repo", async () => {
    const ctx = setup({ 10: "Depends on #11", 11: `Depends on ${STUDIO}#11` }, SPIRAL);
    const { proposal, validation } = await ctx.service.stage({ repo: SPIRAL, issue_numbers: [10, 11] });

    expect(validation.status).toBe("valid");
    expect(brief(proposal)).toEqual([
      "n10 create_work_item spiral-time-10",
      "n11 create_work_item spiral-time-11",
      "e1 create_edge spiral-time-10:depends_on:spiral-time-11",
      "e2 create_edge spiral-time-11:depends_on:studio-11",
    ]);
  });

  it("reports a cycle on the edge that closes it, and still stages the proposal for review", async () => {
    // Existing: studio-10 depends_on studio-11. Import: studio-11 <- 20 <- ... -> closes 11 -> 20 -> 10 -> 11.
    const ctx = setup({ 20: "Depends on #10\nBlocks #11" });
    const { proposal, validation } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });

    expect(validation.status).toBe("validation_failed");
    const errors = (validation as GraphMutationsValidationFailedResult).errors;
    expect(errors.map((error) => [error.mutation_id, error.code])).toEqual([["e2", "cycle"]]);
    expect(proposal.mutations.find((mutation) => mutation.id === "e2")?.validation).toEqual({ errors });
    expect(proposal.mutations.find((mutation) => mutation.id === "e1")?.validation).toBeUndefined();
    expect(ctx.proposalState.getActiveProposal()).toBe(proposal);
  });

  it("rejects issues that are tracked, closed, missing or malformed, before reading any body", async () => {
    const ctx = setup({ 20: "" });
    const stage = (issue_numbers: unknown) => ctx.service.stage({ repo: STUDIO, issue_numbers: issue_numbers as number[] });

    await expect(stage([10])).rejects.toThrow(/not an open, untracked issue/);
    await expect(stage([20, 404])).rejects.toBeInstanceOf(BadRequestException);
    await expect(stage([])).rejects.toThrow(/at least one issue/);
    await expect(stage([1.5])).rejects.toThrow(/positive integers/);
    await expect(stage(Array.from({ length: 51 }, (_, index) => index + 100))).rejects.toThrow(/At most 50/);
    await expect(ctx.service.stage({ repo: "not/included", issue_numbers: [20] })).rejects.toThrow(/not included in Settings/);
    expect(ctx.lookup.issueWithBody).not.toHaveBeenCalled();
    expect(ctx.proposalState.getActiveProposal()).toBeNull();
  });

  it("stages nothing when GitHub cannot be read", async () => {
    const ctx = setup({ 20: "" });
    ctx.lookup.issueWithBody.mockRejectedValueOnce(new Error("gh command timed out after 30000ms"));
    await expect(ctx.service.stage({ repo: STUDIO, issue_numbers: [20] })).rejects.toBeInstanceOf(BadGatewayException);
    expect(ctx.proposalState.getActiveProposal()).toBeNull();
  });
});

describe("approving an import proposal (#281)", () => {
  const approve = (ctx: ReturnType<typeof setup>, proposalId: string, ids: string[]) =>
    ctx.planning.approveProposal({ proposal_id: proposalId, approved_mutation_ids: ids });

  it("applies nodes and edges in one batch, with evidence stored on the edges", async () => {
    const ctx = setup({ 20: "Depends on #10", 21: "Part of #20" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20, 21] });

    const commit = await approve(ctx, proposal.proposal_id, proposal.mutations.map((mutation) => mutation.id));

    expect(commit.result.status).toBe("applied");
    expect(commit.active_proposal).toBeNull();
    expect(ctx.itemIds()).toEqual(["studio-10", "studio-11", "studio-20", "studio-21"]);
    expect(ctx.sqlite.getGraphVersion()).toBe("1");
    const imported = ctx.edges().slice(1);
    expect(imported.map((edge) => `${edge.from_id} ${edge.rel} ${edge.to_id} ${edge.confidence}`)).toEqual([
      "studio-20 depends_on studio-10 certain", "studio-21 is_part_of studio-20 certain",
    ]);
    expect(JSON.parse(imported[0].meta)).toEqual({ evidence: [{ source: "issue_body", issue: `${STUDIO}#20`, quote: "Depends on #10" }] });
  });

  it("starts imported nodes in planned, with their issue link", async () => {
    const ctx = setup({ 20: "" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });
    await approve(ctx, proposal.proposal_id, ["n20"]);
    const row = ctx.sqlite.getDb().prepare("SELECT state, kind, repo, issue_number, issue_url FROM work_items WHERE id = 'studio-20'").get();
    expect(row).toEqual({ state: "planned", kind: "issue", repo: STUDIO, issue_number: 20, issue_url: `https://github.com/${STUDIO}/issues/20` });
  });

  it("lets a node be approved without its edges, leaving the edges in the proposal", async () => {
    const ctx = setup({ 20: "Depends on #10" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });
    const commit = await approve(ctx, proposal.proposal_id, ["n20"]);
    expect(commit.result.status).toBe("applied");
    expect(ctx.edges()).toHaveLength(1);
    expect(commit.active_proposal?.mutations.map((mutation) => mutation.id)).toEqual(["e1"]);
  });

  it("writes nothing when an edge is approved without its node", async () => {
    const ctx = setup({ 20: "Depends on #10" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });
    const commit = await approve(ctx, proposal.proposal_id, ["e1"]);
    expect(commit.result.status).toBe("validation_failed");
    expect((commit.result as GraphMutationsValidationFailedResult).errors[0].code).toBe("missing_entity");
    expect(ctx.edges()).toHaveLength(1);
    expect(ctx.sqlite.getGraphVersion()).toBe("0");
  });

  it("writes nothing when the batch contains a cycle, and applies once the closing edge is left out", async () => {
    const ctx = setup({ 20: "Depends on #10\nBlocks #11" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });

    const refused = await approve(ctx, proposal.proposal_id, ["n20", "e1", "e2"]);
    expect(refused.result.status).toBe("validation_failed");
    expect(ctx.itemIds()).toEqual(["studio-10", "studio-11"]);

    const applied = await approve(ctx, proposal.proposal_id, ["n20", "e1"]);
    expect(applied.result.status).toBe("applied");
    expect(ctx.itemIds()).toContain("studio-20");
  });

  it("refuses a proposal staged against an older graph version", async () => {
    const ctx = setup({ 20: "Depends on #10" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });
    new GraphWriterService(ctx.sqlite).apply({ mutations: [{ kind: "create_work_item", work_item: { id: "other", name: "Other", kind: "capability" } }] });

    const commit = await approve(ctx, proposal.proposal_id, ["n20", "e1"]);
    expect(commit.result.status).toBe("stale");
    expect(ctx.itemIds()).not.toContain("studio-20");
  });

  it("refuses a second import of the same issue once the first is applied", async () => {
    const ctx = setup({ 20: "" });
    const { proposal } = await ctx.service.stage({ repo: STUDIO, issue_numbers: [20] });
    await approve(ctx, proposal.proposal_id, ["n20"]);
    await expect(ctx.service.stage({ repo: STUDIO, issue_numbers: [20] })).rejects.toThrow(/not an open, untracked issue/);
  });
});

describe("scopeHint", () => {
  it("takes the first line of prose, skipping headings, comments, task lists, tables and code", () => {
    expect(scopeHint("## Summary\n\n<!-- note -->\n- [ ] #1\n| a | b |\n```\ncode\n```\n- **Studio** only reconciles [linked](http://x) `issues`.\nMore.")).toBe("Studio only reconciles linked issues.");
  });
  it("caps the length and returns null for an empty body", () => {
    expect(scopeHint("x".repeat(300))).toHaveLength(160);
    expect(scopeHint("")).toBeNull();
    expect(scopeHint(null)).toBeNull();
  });
});
