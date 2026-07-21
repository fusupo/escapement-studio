import { describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import * as executionRefinement from "../../../../web/src/lib/execution-refinement.js";

const { refinementResponseFor, unresolvedRefinementItems } = executionRefinement;

const run = {
  run_id: "exec_123",
  refinement: {
    items: [
      { id: "question-1", prompt: "Question one", response: null },
      { id: "question-2", prompt: "Question two", response: "persisted answer" },
    ],
  },
};

describe("execution refinement drafts", () => {
  it("counts local textarea answers as resolved immediately", () => {
    const responses = { "exec_123:question-1": "local answer" };

    expect(refinementResponseFor(run, run.refinement.items[0], responses)).toBe("local answer");
    expect(unresolvedRefinementItems(run, responses)).toEqual([]);
  });

  it("keeps blank local responses unresolved", () => {
    const responses = { "exec_123:question-1": "   " };

    expect(unresolvedRefinementItems(run, responses).map((item: { id: string }) => item.id)).toEqual(["question-1"]);
  });
});
