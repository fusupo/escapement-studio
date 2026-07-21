import { describe, expect, it } from "vitest";
import { ScratchpadService } from "../scratchpad.service.js";

function parseChecklist(content: string) {
  const service = Object.create(ScratchpadService.prototype) as ScratchpadService;
  return service.parseChecklistProjection(content);
}

describe("parseChecklistProjection", () => {
  it("categorizes supported checklist sections and derives implementation rows", () => {
    const items = parseChecklist([
      "## Acceptance Criteria",
      "- [x] User-visible behavior works",
      "## Implementation Plan",
      "- [ ] Implement the behavior",
      "- [X] Add tests",
      "## Quality Checks",
      "- [x] npm test",
      "## Manual Verification",
      "- [ ] Check narrow layout",
    ].join("\n"));

    expect(items).toEqual([
      { checked: true, text: "User-visible behavior works", category: "acceptance" },
      { checked: false, text: "Implement the behavior", category: "implementation" },
      { checked: true, text: "Add tests", category: "implementation" },
      { checked: true, text: "npm test", category: "verification" },
      { checked: false, text: "Check narrow layout", category: "verification" },
    ]);
    const implementation = items.filter((item) => item.category === "implementation");
    expect({ completed: implementation.filter((item) => item.checked).length, total: implementation.length })
      .toEqual({ completed: 1, total: 2 });
  });

  it("uses the last exact H2 when issue-body and canonical headings repeat", () => {
    const items = parseChecklist([
      "## Acceptance Criteria",
      "- [ ] Issue-body criterion",
      "## Notes",
      "## Implementation Plan (draft)",
      "- [ ] Similar but not exact",
      "## Acceptance Criteria",
      "### Required behavior",
      "  - [x] Canonical criterion",
      "## Implementation Plan",
      "- [ ] Canonical task",
    ].join("\n"));

    expect(items).toEqual([
      { checked: true, text: "Canonical criterion", category: "acceptance" },
      { checked: false, text: "Canonical task", category: "implementation" },
    ]);
  });

  it("allows nested headings and indented task rows but stops at the next H2", () => {
    const items = parseChecklist([
      "## Implementation Plan",
      "### Backend",
      "  - [ ] Indented item",
      "    - [x] Deeply indented",
      "## Work Log",
      "- [ ] Not a task",
    ].join("\n"));

    expect(items).toEqual([
      { checked: false, text: "Indented item", category: "implementation" },
      { checked: true, text: "Deeply indented", category: "implementation" },
    ]);
  });

  it("handles unchecked, lowercase, and uppercase checkbox variants", () => {
    expect(parseChecklist([
      "## Implementation Plan",
      "- [ ] Pending",
      "- [x] Lowercase",
      "- [X] Uppercase",
    ].join("\n"))).toEqual([
      { checked: false, text: "Pending", category: "implementation" },
      { checked: true, text: "Lowercase", category: "implementation" },
      { checked: true, text: "Uppercase", category: "implementation" },
    ]);
  });

  it("returns an empty projection when supported sections are missing or empty", () => {
    expect(parseChecklist("## Context\n- [ ] Not a checklist")).toEqual([]);
    expect(parseChecklist("## Implementation Plan\n<!-- no tasks yet -->")).toEqual([]);
    expect(parseChecklist("")).toEqual([]);
  });

  it("supports either verification heading independently", () => {
    expect(parseChecklist("## Quality Checks\n- [ ] Automated checks")).toEqual([
      { checked: false, text: "Automated checks", category: "verification" },
    ]);
    expect(parseChecklist("## Manual Verification\n- [x] Browser checked")).toEqual([
      { checked: true, text: "Browser checked", category: "verification" },
    ]);
  });
});
