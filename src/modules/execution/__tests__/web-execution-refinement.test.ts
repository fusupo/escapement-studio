import { describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import * as refinement from "../../../../web/src/lib/execution-refinement.js";

const legacy = { id: "question-1", prompt: "Open question", response: null };
const structured = {
  id: "question-2",
  prompt: "Choose",
  options: [
    { id: "safe", label: "Safe", description: "Recommended path" },
    { id: "fast", label: "Fast" },
  ],
  recommended_option_id: "safe",
  allow_other: true,
  selected_option_id: null,
  response: null,
};
const fixed = { ...structured, id: "blocker-1", allow_other: false };

function makeRun(items: any[] = [legacy, structured, fixed]) {
  return { run_id: "exec_123", refinement: { items } };
}

describe("execution refinement drafts", () => {
  it("seeds controls from persisted selection, custom text, and legacy text without preselecting recommendations", () => {
    expect(refinement.seedRefinementDraft({ ...structured, selected_option_id: "fast", response: "Fast" }))
      .toEqual({ mode: "option", selected_option_id: "fast", text: "" });
    expect(refinement.seedRefinementDraft({ ...structured, response: "Custom" }))
      .toEqual({ mode: "other", selected_option_id: null, text: "Custom" });
    expect(refinement.seedRefinementDraft({ ...legacy, response: "Legacy" }))
      .toEqual({ mode: "legacy", selected_option_id: null, text: "Legacy" });
    expect(refinement.seedRefinementDraft(structured).selected_option_id).toBeNull();
  });

  it("migrates old string drafts only to compatible modes", () => {
    expect(refinement.coerceRefinementDraft(legacy, "old"))
      .toEqual({ mode: "legacy", selected_option_id: null, text: "old" });
    expect(refinement.coerceRefinementDraft(structured, "old"))
      .toEqual({ mode: "other", selected_option_id: null, text: "old" });
    expect(refinement.coerceRefinementDraft(fixed, "old")).toBeNull();
  });

  it("uses a valid local key over persisted state, including an explicit blank", () => {
    const persisted = { ...legacy, response: "persisted" };
    const run = makeRun([persisted]);
    const drafts = { "exec_123:question-1": { mode: "legacy", selected_option_id: null, text: "" } };
    expect(refinement.refinementDraftFor(run, persisted, drafts).text).toBe("");
    expect(refinement.unresolvedRefinementItems(run, drafts)).toEqual([persisted]);
  });

  it("falls back to persisted state for an invalid local draft", () => {
    const persisted = { ...fixed, selected_option_id: "fast", response: "Fast" };
    const run = makeRun([persisted]);
    expect(refinement.refinementDraftFor(run, persisted, { "exec_123:blocker-1": "stale string" }))
      .toEqual({ mode: "option", selected_option_id: "fast", text: "" });
  });

  it("switches options and Other immutably", () => {
    const initial = refinement.seedRefinementDraft(structured);
    const selected = refinement.selectRefinementOption(structured, initial, "safe");
    expect(selected).toEqual({ mode: "option", selected_option_id: "safe", text: "" });
    expect(initial.selected_option_id).toBeNull();

    const other = refinement.selectRefinementOther(structured, selected);
    expect(other).toEqual({ mode: "other", selected_option_id: null, text: "" });
    const typed = refinement.updateRefinementOther(structured, other, " custom ");
    expect(refinement.isRefinementDraftAnswered(structured, typed)).toBe(true);
    expect(refinement.isRefinementDraftAnswered(structured, { ...typed, text: " " })).toBe(false);
    expect(refinement.selectRefinementOther(fixed, selected)).toEqual(selected);
  });

  it("restores valid object drafts across SSE/reconnect replacement", () => {
    const local = { mode: "option", selected_option_id: "safe", text: "" };
    const replacement = { ...structured, selected_option_id: "fast", response: "Fast" };
    expect(refinement.refinementDraftFor(makeRun([replacement]), replacement, {
      "exec_123:question-2": local,
    })).toEqual(local);
  });

  it("projects listed meaning, Other/legacy text, cancellation, and omits unresolved items", () => {
    const run = makeRun();
    const drafts = {
      "exec_123:question-1": refinement.updateLegacyRefinement(legacy, " legacy answer "),
      "exec_123:question-2": refinement.selectRefinementOption(structured, null, "safe"),
      "exec_123:blocker-1": refinement.selectRefinementOption(fixed, null, "fast"),
    };
    expect(refinement.projectRefinementResponses(run, drafts)).toEqual([
      { item_id: "question-1", response: "legacy answer" },
      { item_id: "question-2", selected_option_id: "safe", response: "Safe — Recommended path" },
      { item_id: "blocker-1", selected_option_id: "fast", response: "Fast" },
    ]);

    const cancelItem = {
      ...fixed,
      options: [fixed.options[0], { id: "cancel", label: "Cancel execution", action: "cancel_execution" }],
    };
    expect(refinement.projectRefinementResponses(makeRun([cancelItem]), {
      "exec_123:blocker-1": { mode: "option", selected_option_id: "cancel", text: "" },
    })).toEqual([{ item_id: "blocker-1", selected_option_id: "cancel", response: "Cancel execution" }]);
  });

  it("counts blank custom/legacy and unselected structured drafts as unresolved", () => {
    const run = makeRun();
    const drafts = {
      "exec_123:question-1": { mode: "legacy", selected_option_id: null, text: " " },
      "exec_123:question-2": { mode: "other", selected_option_id: null, text: "" },
    };
    expect(refinement.unresolvedRefinementItems(run, drafts).map((item: { id: string }) => item.id))
      .toEqual(["question-1", "question-2", "blocker-1"]);
  });
});
