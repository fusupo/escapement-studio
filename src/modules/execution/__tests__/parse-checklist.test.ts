import { describe, it, expect } from "vitest";
import { ScratchpadService } from "../scratchpad.service.js";

/**
 * Phase 4c (#232): parseImplementationPlanChecklist lives on
 * ScratchpadService. The method is a pure parser, so the harness
 * constructs a bare ScratchpadService instance via Object.create.
 */
function parseChecklist(content: string) {
  const service = Object.create(ScratchpadService.prototype) as ScratchpadService;
  return service.parseImplementationPlanChecklist(content);
}

describe("parseImplementationPlanChecklist", () => {
  it("extracts checklist items from the Implementation Plan section", () => {
    const content = [
      "# Scratchpad",
      "",
      "## Context",
      "- **Repo:** test",
      "",
      "## Implementation Plan",
      "",
      "- [ ] Analyze scope and identify changes needed",
      "- [x] Implement changes",
      "- [ ] Run tests / verify",
      "- [x] Summarize results",
      "",
      "## Work Log",
      "- Some note",
      "",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([
      { checked: false, text: "Analyze scope and identify changes needed" },
      { checked: true, text: "Implement changes" },
      { checked: false, text: "Run tests / verify" },
      { checked: true, text: "Summarize results" },
    ]);
  });

  it("ignores checkbox lines outside the Implementation Plan section", () => {
    const content = [
      "## Context",
      "- [ ] This should be ignored",
      "",
      "## Implementation Plan",
      "- [ ] Real item",
      "",
      "## Work Log",
      "- [ ] This is also ignored",
      "",
      "## Blockers",
      "- [x] Ignored too",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([{ checked: false, text: "Real item" }]);
  });

  it("returns empty array when there is no Implementation Plan section", () => {
    const content = [
      "## Context",
      "Some content",
      "",
      "## Work Log",
      "- [ ] Not in Implementation Plan",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    expect(parseChecklist("")).toEqual([]);
  });

  it("handles uppercase X in checkboxes", () => {
    const content = [
      "## Implementation Plan",
      "- [X] Done item",
      "- [ ] Pending item",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([
      { checked: true, text: "Done item" },
      { checked: false, text: "Pending item" },
    ]);
  });

  it("handles indented checklist items", () => {
    const content = [
      "## Implementation Plan",
      "  - [ ] Indented item",
      "    - [x] Deeply indented",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([
      { checked: false, text: "Indented item" },
      { checked: true, text: "Deeply indented" },
    ]);
  });

  it("stops at the next ## heading", () => {
    const content = [
      "## Implementation Plan",
      "- [ ] First",
      "- [x] Second",
      "## Blockers",
      "- [ ] Not a plan item",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([
      { checked: false, text: "First" },
      { checked: true, text: "Second" },
    ]);
  });

  it("skips non-checklist lines within the section", () => {
    const content = [
      "## Implementation Plan",
      "<!-- comment -->",
      "",
      "- [ ] Real item",
      "Some random text",
      "- [x] Another item",
    ].join("\n");

    const items = parseChecklist(content);
    expect(items).toEqual([
      { checked: false, text: "Real item" },
      { checked: true, text: "Another item" },
    ]);
  });
});
