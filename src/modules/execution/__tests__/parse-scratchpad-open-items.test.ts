import { describe, expect, it } from "vitest";
import { ScratchpadService, type ParsedScratchpadOpenItem } from "../scratchpad.service.js";

interface Harness {
  parseScratchpadOpenItems: (
    content: string,
  ) => { questions: ParsedScratchpadOpenItem[]; blockers: ParsedScratchpadOpenItem[] };
}

function makeHarness(): Harness {
  return Object.create(ScratchpadService.prototype) as Harness;
}

const prompt = (text: string): ParsedScratchpadOpenItem => ({ prompt: text });

describe("ScratchpadService.parseScratchpadOpenItems", () => {
  it("parses mixed legacy items from both sections", () => {
    const result = makeHarness().parseScratchpadOpenItems([
      "# Plan: studio-999",
      "### Clarifications Needed",
      "- First question",
      "- Second question",
      "### Assumptions Made",
      "- ignored assumption",
      "## Blockers",
      "- Blocker one",
      "- Blocker two",
    ].join("\n"));

    expect(result.questions).toEqual([prompt("First question"), prompt("Second question")]);
    expect(result.blockers).toEqual([prompt("Blocker one"), prompt("Blocker two")]);
  });

  it("parses valid choice metadata, recommendation, Other policy, and cancellation", () => {
    const result = makeHarness().parseScratchpadOpenItems([
      "### Clarifications Needed",
      "- Which API?",
      "  ```execution-refinement",
      "  {",
      "    \"options\": [",
      "      { \"id\": \"a\", \"label\": \"API A\", \"description\": \"Stable\" },",
      "      { \"id\": \"b\", \"label\": \"API B\" }",
      "    ],",
      "    \"recommended_option_id\": \"a\",",
      "    \"allow_other\": true",
      "  }",
      "  ```",
      "## Blockers",
      "- How should this blocker be handled?",
      "  ```execution-refinement",
      "  {\"options\":[{\"id\":\"revise\",\"label\":\"Revise plan\"},{\"id\":\"cancel\",\"label\":\"Cancel execution\",\"action\":\"cancel_execution\"}],\"allow_other\":false}",
      "  ```",
    ].join("\n"));

    expect(result.questions[0]).toEqual({
      prompt: "Which API?",
      metadata: {
        options: [
          { id: "a", label: "API A", description: "Stable" },
          { id: "b", label: "API B" },
        ],
        recommended_option_id: "a",
        allow_other: true,
      },
    });
    expect(result.blockers[0].metadata?.options[1]).toEqual({
      id: "cancel",
      label: "Cancel execution",
      action: "cancel_execution",
    });
    expect(result.blockers[0].metadata?.allow_other).toBe(false);
  });

  it("drops dangling recommendations while retaining valid options", () => {
    const result = makeHarness().parseScratchpadOpenItems([
      "### Clarifications Needed",
      "- Choose",
      "  ```execution-refinement",
      "  {\"options\":[{\"id\":\"a\",\"label\":\"A\"},{\"id\":\"b\",\"label\":\"B\"}],\"recommended_option_id\":\"missing\"}",
      "  ```",
    ].join("\n"));
    expect(result.questions[0].metadata).toEqual({ options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  });

  it.each([
    ["malformed JSON", "{not json}"],
    ["too few options", "{\"options\":[{\"id\":\"a\",\"label\":\"A\"}]}"],
    ["duplicate IDs", "{\"options\":[{\"id\":\"a\",\"label\":\"A\"},{\"id\":\"a\",\"label\":\"B\"}]}"],
    ["blank label", "{\"options\":[{\"id\":\"a\",\"label\":\" \"},{\"id\":\"b\",\"label\":\"B\"}]}"],
    ["blank description", "{\"options\":[{\"id\":\"a\",\"label\":\"A\",\"description\":\" \"},{\"id\":\"b\",\"label\":\"B\"}]}"],
    ["cancellation on a question", "{\"options\":[{\"id\":\"a\",\"label\":\"A\",\"action\":\"cancel_execution\"},{\"id\":\"b\",\"label\":\"B\"}]}"],
  ])("degrades %s metadata to a legacy item", (_label, json) => {
    const result = makeHarness().parseScratchpadOpenItems([
      "### Clarifications Needed",
      "- Legacy fallback",
      "  ```execution-refinement",
      `  ${json}`,
      "  ```",
    ].join("\n"));
    expect(result.questions).toEqual([prompt("Legacy fallback")]);
  });

  it.each([
    ["detached", ["- Legacy", "", "  ```execution-refinement", "  {}", "  ```"]],
    ["unindented", ["- Legacy", "```execution-refinement", "{}", "```"]],
    ["wrong language", ["- Legacy", "  ```json", "  {}", "  ```"]],
    ["unterminated", ["- Legacy", "  ```execution-refinement", "  {}"]],
    ["indented bullet", ["  - Legacy", "  ```execution-refinement", "  {}", "  ```"]],
  ])("does not bind %s metadata", (_label, lines) => {
    const result = makeHarness().parseScratchpadOpenItems([
      "### Clarifications Needed",
      ...lines,
    ].join("\n"));
    expect(result.questions[0]).toEqual(prompt("Legacy"));
  });

  it("handles sentinels, missing sections, headings, whitespace, and CRLF", () => {
    const content = [
      "### Clarifications Needed",
      "_(none)_",
      "### Assumptions Made",
      "- ignored",
      "## Blockers",
      "   - spaced blocker   ",
      "## Work Log",
      "- ignored",
    ].join("\r\n");
    const result = makeHarness().parseScratchpadOpenItems(content);
    expect(result.questions).toEqual([]);
    expect(result.blockers).toEqual([prompt("spaced blocker")]);
    expect(makeHarness().parseScratchpadOpenItems("")).toEqual({ questions: [], blockers: [] });
  });

  it("accepts H2 clarification and H3 blocker headings from refined plans", () => {
    const result = makeHarness().parseScratchpadOpenItems([
      "## Clarifications Needed",
      "- Clarification written at H2",
      "### Blockers",
      "- Blocker written at H3",
    ].join("\n"));

    expect(result).toEqual({
      questions: [prompt("Clarification written at H2")],
      blockers: [prompt("Blocker written at H3")],
    });
  });
});
