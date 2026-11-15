import { describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import * as selection from "../../../../web/src/lib/planning/proposal-selection.js";

const { defaultSelection, edgeEvidence, groupMutations, isImportProposal, toggleSelection } = selection;

const node = (id: string, group: string, extra: Record<string, unknown> = {}) => ({ id, type: "create_work_item", group_id: group, ...extra });
const edge = (id: string, group: string, needs: string[], extra: Record<string, unknown> = {}) =>
  ({ id, type: "create_edge", group_id: group, depends_on_mutation_ids: needs, ...extra });

const proposal = {
  proposal_id: "p1",
  source: { agent: "issue-import" },
  mutations: [
    node("n20", "issue-20"),
    node("n21", "issue-21"),
    edge("e1", "issue-20", ["n20"]),
    edge("e2", "issue-20", ["n20", "n21"]),
    edge("e3", "issue-21", ["n21"], { validation: { errors: [{ code: "cycle", message: "would create a cycle" }] } }),
  ],
};

describe("proposal selection (#281)", () => {
  it("ticks everything that passed validation", () => {
    expect(defaultSelection(proposal)).toEqual(["n20", "n21", "e1", "e2"]);
    expect(defaultSelection(null)).toEqual([]);
  });

  it("leaves an edge unticked when the node it needs failed validation", () => {
    const failing = { ...proposal, mutations: [node("n20", "g", { validation: { errors: [{ message: "duplicate" }] } }), edge("e1", "g", ["n20"]), node("n21", "g")] };
    expect(defaultSelection(failing)).toEqual(["n21"]);
  });

  it("unticks a node's edges with it, and lets an edge be unticked alone", () => {
    const all = ["n20", "n21", "e1", "e2"];
    expect(toggleSelection(proposal, all, "n21", false)).toEqual(["n20", "e1"]);
    expect(toggleSelection(proposal, all, "e1", false)).toEqual(["n20", "n21", "e2"]);
  });

  it("ticks the nodes an edge needs when the edge is ticked", () => {
    expect(toggleSelection(proposal, [], "e2", true)).toEqual(["n20", "n21", "e2"]);
    expect(toggleSelection(proposal, ["n20"], "n21", true)).toEqual(["n20", "n21"]);
  });

  it("ignores dependencies that are not part of the proposal any more", () => {
    const remaining = { ...proposal, mutations: [edge("e1", "issue-20", ["n20"])] };
    expect(toggleSelection(remaining, [], "e1", true)).toEqual(["e1"]);
  });

  it.each(["inferred", "ambiguous"])("requires explicit approval for %s import edges, including restored/remaining proposals", (confidence) => {
    const suggestion = edge("i0001", "issue-20", ["n20", "n21"], { payload: { confidence } });
    const mixed = { ...proposal, mutations: [...proposal.mutations, suggestion] };
    expect(defaultSelection(mixed)).toEqual(["n20", "n21", "e1", "e2"]);
    expect(toggleSelection(mixed, [], "i0001", true)).toEqual(["n20", "n21", "i0001"]);
    expect(toggleSelection(mixed, [], "n20", true)).toEqual(["n20"]);
    expect(toggleSelection(mixed, ["n20", "n21", "i0001"], "n21", false)).toEqual(["n20"]);
    const remaining = { ...mixed, mutations: [suggestion] };
    expect(defaultSelection(remaining)).toEqual([]);
    expect(toggleSelection(remaining, [], "i0001", true)).toEqual(["i0001"]);
    expect(defaultSelection({ ...remaining, source: { agent: "root-planner" } })).toEqual(["i0001"]);
    expect(defaultSelection({ ...mixed, source: { agent: "root-planner" } })).toContain("i0001");
  });

  it("groups an issue's node before its edges and keeps ungrouped mutations apart", () => {
    const mixed = { proposal_id: "p", mutations: [edge("e1", "issue-20", []), node("n20", "issue-20"), { id: "m3", type: "update_work_item" }, { id: "m4", type: "delete_edge" }] };
    expect(groupMutations(mixed).map((group: any) => [group.key, group.mutations.map((mutation: any) => mutation.id)])).toEqual([
      ["issue-20", ["n20", "e1"]], ["mutation:m3", ["m3"]], ["mutation:m4", ["m4"]],
    ]);
  });

  it("labels where an edge comes from", () => {
    const stated = { type: "create_edge", payload: { confidence: "certain", meta: { evidence: [{ source: "issue_body", issue: "a/b#20", quote: "Depends on #10" }] } } };
    expect(edgeEvidence(stated)).toEqual({ kind: "deterministic", label: "from issue text", quotes: [{ issue: "a/b#20", quote: "Depends on #10" }] });
    expect(edgeEvidence({ type: "create_edge", payload: { confidence: "inferred" } })).toMatchObject({ kind: "inferred", label: "model-inferred" });
    expect(edgeEvidence({ type: "create_edge", payload: { confidence: "ambiguous", meta: { evidence: [{ source: "issue_body", quote: "q" }] } } })?.kind).toBe("inferred");
    expect(edgeEvidence({ type: "create_edge", payload: { from_id: "a" } })).toBeNull();
    expect(edgeEvidence({ type: "create_work_item", payload: {} })).toBeNull();
  });

  it("recognises an import proposal by its source", () => {
    expect(isImportProposal(proposal)).toBe(true);
    expect(isImportProposal({ proposal_id: "p", source: { agent: "root-planner" } })).toBe(false);
    expect(isImportProposal(null)).toBe(false);
  });
});
