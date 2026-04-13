import { describe, expect, it } from "vitest";
import { ScratchpadService } from "../scratchpad.service.js";

/**
 * Unit tests for the `parseScratchpadOpenItems` helper.
 *
 * Phase 4c (#232): the parser lives on ScratchpadService. Uses the
 * `Object.create(ScratchpadService.prototype)` harness pattern so we
 * can exercise the pure method without booting Nest DI.
 */

interface Harness {
  parseScratchpadOpenItems: (
    content: string,
  ) => { questions: string[]; blockers: string[] };
}

function makeHarness(): Harness {
  return Object.create(ScratchpadService.prototype) as Harness;
}

describe("ScratchpadService.parseScratchpadOpenItems", () => {
  it("parses items from both sections when both are populated", () => {
    const h = makeHarness();
    const content = [
      "# Plan: studio-999",
      "",
      "## Questions / Concerns",
      "",
      "### Clarifications Needed",
      "",
      "- First question",
      "- Second question",
      "",
      "### Assumptions Made",
      "",
      "- some assumption",
      "",
      "## Blockers",
      "",
      "- Blocker one",
      "- Blocker two",
      "",
    ].join("\n");

    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual(["First question", "Second question"]);
    expect(result.blockers).toEqual(["Blocker one", "Blocker two"]);
  });

  it("returns empty arrays when both sections are _(none)_", () => {
    const h = makeHarness();
    const content = [
      "## Questions / Concerns",
      "",
      "### Clarifications Needed",
      "",
      "_(none)_",
      "",
      "### Assumptions Made",
      "",
      "_(none)_",
      "",
      "## Blockers",
      "",
      "_(none)_",
      "",
    ].join("\n");

    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it("returns empty questions when the `### Clarifications Needed` heading is missing", () => {
    const h = makeHarness();
    const content = [
      "# Plan: studio-999",
      "",
      "## Blockers",
      "",
      "- Only blocker",
      "",
    ].join("\n");

    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual([]);
    expect(result.blockers).toEqual(["Only blocker"]);
  });

  it("returns empty blockers when the `## Blockers` heading is missing", () => {
    const h = makeHarness();
    const content = [
      "## Questions / Concerns",
      "",
      "### Clarifications Needed",
      "",
      "- The only question",
      "",
    ].join("\n");

    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual(["The only question"]);
    expect(result.blockers).toEqual([]);
  });

  it("tolerates leading/trailing whitespace and blank lines between bullets", () => {
    const h = makeHarness();
    const content = [
      "### Clarifications Needed",
      "",
      "   - indented question   ",
      "",
      "- second question",
      "",
      "",
      "## Blockers",
      "",
      "- spaced blocker   ",
      "",
    ].join("\n");

    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual(["indented question", "second question"]);
    expect(result.blockers).toEqual(["spaced blocker"]);
  });

  it("stops collecting at the next heading (e.g. ### Assumptions Made)", () => {
    const h = makeHarness();
    const content = [
      "### Clarifications Needed",
      "",
      "- kept question",
      "",
      "### Assumptions Made",
      "",
      "- should not be collected as a question",
      "",
      "## Blockers",
      "",
      "- kept blocker",
      "",
      "## Work Log",
      "",
      "- should not be collected as a blocker",
      "",
    ].join("\n");

    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual(["kept question"]);
    expect(result.blockers).toEqual(["kept blocker"]);
  });

  it("returns empty arrays for an empty string", () => {
    const h = makeHarness();
    const result = h.parseScratchpadOpenItems("");
    expect(result.questions).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const h = makeHarness();
    const content =
      "### Clarifications Needed\r\n\r\n- crlf question\r\n\r\n## Blockers\r\n\r\n- crlf blocker\r\n";
    const result = h.parseScratchpadOpenItems(content);
    expect(result.questions).toEqual(["crlf question"]);
    expect(result.blockers).toEqual(["crlf blocker"]);
  });
});
