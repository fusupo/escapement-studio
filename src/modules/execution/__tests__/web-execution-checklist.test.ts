import { describe, expect, it } from "vitest";
// @ts-expect-error Browser synchronization helper is intentionally plain JavaScript.
import * as checklistSync from "../../../../web/src/lib/checklist-sync.js";

const { isValidChecklistSnapshot, mergeChecklistSnapshot, shouldReplaceChecklistSnapshot } = checklistSync;

function snapshot(revision: number, checked = false, runId = "exec_278") {
  return {
    run_id: runId,
    revision,
    updated_at: revision === 0 ? null : `2026-07-21T12:00:0${revision}.000Z`,
    items: [{ text: "Implement durable progress", checked, category: "implementation" }],
    completed: checked ? 1 : 0,
    total: 1,
  };
}

describe("execution checklist synchronization", () => {
  it("accepts the first valid snapshot", () => {
    expect(shouldReplaceChecklistSnapshot(undefined, snapshot(0), "exec_278")).toBe(true);
    expect(mergeChecklistSnapshot(undefined, snapshot(1), "exec_278")).toEqual(snapshot(1));
  });

  it("accepts incremental SSE revisions", () => {
    expect(mergeChecklistSnapshot(snapshot(1), snapshot(2, true), "exec_278"))
      .toEqual(snapshot(2, true));
  });

  it("uses a reconnect REST refresh to converge after missed SSE", () => {
    let cached = snapshot(1);
    const durableRestResponse = snapshot(3, true);
    cached = mergeChecklistSnapshot(cached, durableRestResponse, "exec_278");
    expect(cached).toEqual(durableRestResponse);
  });

  it("rejects duplicate and older revisions", () => {
    const current = snapshot(3, true);
    expect(mergeChecklistSnapshot(current, snapshot(3), "exec_278")).toBe(current);
    expect(mergeChecklistSnapshot(current, snapshot(2), "exec_278")).toBe(current);
  });

  it("does not let a stale REST response overwrite newer racing SSE", () => {
    const requestStartedAt = snapshot(1);
    const afterSse = mergeChecklistSnapshot(requestStartedAt, snapshot(4, true), "exec_278");
    const afterRest = mergeChecklistSnapshot(afterSse, snapshot(2), "exec_278");
    expect(afterRest).toEqual(snapshot(4, true));
  });

  it("rejects malformed and cross-run snapshots", () => {
    expect(isValidChecklistSnapshot({ ...snapshot(1), revision: "1" }, "exec_278")).toBe(false);
    expect(isValidChecklistSnapshot({ ...snapshot(1), completed: 4 }, "exec_278")).toBe(false);
    expect(isValidChecklistSnapshot(snapshot(1, false, "exec_other"), "exec_278")).toBe(false);
    expect(shouldReplaceChecklistSnapshot(snapshot(1), snapshot(2, true, "exec_other"), "exec_278"))
      .toBe(false);
  });
});
