import { describe, expect, it } from "vitest";
import { StudioIssueTemplateService } from "../studio-issue-template.service.js";

describe("StudioIssueTemplateService", () => {
  const service = new StudioIssueTemplateService();

  it("loads the canonical Studio issue templates from .github/ISSUE_TEMPLATE", () => {
    const templates = service.listTemplates();

    expect(templates.map((template) => template.kind)).toEqual(["bug", "feature", "task"]);
    expect(templates[0]?.labels).toContain("bug");
    expect(templates[1]?.labels).toContain("enhancement");
  });

  it("returns bug drafting guidance for bug-creation requests", () => {
    const document = service.getPlanningDocument("file a bug about changed-file parsing dropping the first character");

    expect(document).not.toBeNull();
    expect(document?.content).toContain("Inferred issue kind: bug");
    expect(document?.content).toContain("Selected template: bug");
    expect(document?.content).toContain("## Expected Behavior");
  });

  it("returns feature drafting guidance for generic issue creation requests", () => {
    const document = service.getPlanningDocument("create an issue to support PR creation from completed work");

    expect(document).not.toBeNull();
    expect(document?.content).toContain("Selected template: feature");
    expect(document?.content).toContain("## Proposed Behavior");
  });

  it("does not add issue-template guidance for unrelated prompts", () => {
    expect(service.getPlanningDocument("explain the reconciliation architecture")).toBeNull();
  });
});
