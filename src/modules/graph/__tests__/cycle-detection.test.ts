import { describe, expect, it } from "vitest";
import { findCycleThrough, type CycleEdge } from "../cycle-detection.js";

const dep = (from_id: string, to_id: string): CycleEdge => ({ from_id, rel: "depends_on", to_id });
const part = (from_id: string, to_id: string): CycleEdge => ({ from_id, rel: "is_part_of", to_id });

describe("findCycleThrough", () => {
  it("returns null when the new edge closes nothing", () => {
    expect(findCycleThrough([dep("a", "b"), dep("b", "c")], dep("d", "a"))).toBeNull();
  });

  it("reports a self-loop", () => {
    expect(findCycleThrough([], dep("a", "a"))).toEqual(["a", "a"]);
  });

  it("reports a two-node cycle", () => {
    expect(findCycleThrough([dep("a", "b")], dep("b", "a"))).toEqual(["b", "a", "b"]);
  });

  it("reports the path of a longer cycle", () => {
    expect(findCycleThrough([dep("a", "b"), dep("b", "c"), dep("b", "x")], dep("c", "a"))).toEqual(["c", "a", "b", "c"]);
  });

  it("keeps relations separate", () => {
    expect(findCycleThrough([part("a", "b")], dep("b", "a"))).toBeNull();
    expect(findCycleThrough([part("a", "b")], part("b", "a"))).toEqual(["b", "a", "b"]);
  });

  it("does not constrain implemented_by", () => {
    expect(findCycleThrough([{ from_id: "a", rel: "implemented_by", to_id: "b" }], { from_id: "b", rel: "implemented_by", to_id: "a" })).toBeNull();
  });

  it("ignores a cycle that does not pass through the new edge", () => {
    expect(findCycleThrough([dep("x", "y"), dep("y", "x")], dep("a", "x"))).toBeNull();
  });

  it("gives the same answer when the edge list already holds the candidate", () => {
    expect(findCycleThrough([dep("a", "b"), dep("b", "a")], dep("b", "a"))).toEqual(["b", "a", "b"]);
  });
});
