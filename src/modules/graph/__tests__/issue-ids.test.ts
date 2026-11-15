import { describe, expect, it } from "vitest";
import { initManifest } from "../../../lib/manifest-core.js";
import { checkIdAlignment, deriveIssueWorkItemId, issueIdPrefix, repoIdPrefix } from "../types.js";
import { WorkItemsService } from "../work-items.service.js";

const item = (id: string, repo: string | null, issue_number: number | null, kind = "issue") => ({ id, kind, repo, issue_number });

describe("issue work-item IDs (#281)", () => {
  it("derives the default and a prefixed ID", () => {
    expect(deriveIssueWorkItemId(42)).toBe("studio-42");
    expect(deriveIssueWorkItemId(5, "spiral-time")).toBe("spiral-time-5");
  });

  it("takes a prefix from the repo name", () => {
    expect(repoIdPrefix("corpus-relica/spiral-time")).toBe("spiral-time");
    expect(repoIdPrefix("Owner/My_Repo.JS")).toBe("my-repo-js");
    expect(repoIdPrefix("owner/---")).toBe("studio");
  });

  it("keeps the prefix a repo's items already use", () => {
    const items = [
      item("studio-1", "fusupo/escapement-studio", 1),
      item("studio-2", "fusupo/escapement-studio", 2),
      item("legacy-3", "fusupo/escapement-studio", 3),
      item("studio-9", "fusupo/escapement-studio", 4), // misaligned: not counted
      item("phase-1", "fusupo/escapement-studio", null, "phase"),
    ];
    expect(issueIdPrefix("fusupo/escapement-studio", items)).toBe("studio");
    expect(issueIdPrefix("corpus-relica/spiral-time", items)).toBe("spiral-time");
    expect(issueIdPrefix(null, items)).toBe("studio");
  });

  it("accepts any prefix that ends in the issue number", () => {
    expect(checkIdAlignment("studio-42", "issue", 42)).toBeNull();
    expect(checkIdAlignment("spiral-time-42", "issue", 42)).toBeNull();
    expect(checkIdAlignment("studio-142", "issue", 42)).toContain('ending in "-42"');
    expect(checkIdAlignment("42", "issue", 42)).not.toBeNull();
    expect(checkIdAlignment("anything", "capability", 42)).toBeNull();
  });
});

describe("WorkItemsService issue IDs (#281)", () => {
  function setup() {
    const db = initManifest(":memory:");
    const insert = db.prepare(
      `INSERT INTO work_items (id, name, kind, state, repo, issue_number, predicted_files, actual_files, meta)
       VALUES (?, ?, 'issue', 'planned', ?, ?, '[]', '[]', '{}')`,
    );
    insert.run("studio-1", "One", "fusupo/escapement-studio", 1);
    insert.run("studio-2", "Two", "fusupo/escapement-studio", 2);
    insert.run("studio-7", "Wrong number", "fusupo/escapement-studio", 3);
    insert.run("studio-5", "Wrong prefix", "corpus-relica/spiral-time", 5);
    insert.run("spiral-time-6", "Six", "corpus-relica/spiral-time", 6);
    insert.run("spiral-time-8", "Eight", "corpus-relica/spiral-time", 8);
    const service = Object.create(WorkItemsService.prototype) as WorkItemsService;
    Object.defineProperty(service, "sqlite", { value: { getDb: () => db } });
    return service;
  }

  it("derives the next ID per repo", () => {
    const service = setup();
    expect(service.deriveIssueId("fusupo/escapement-studio", 300)).toBe("studio-300");
    expect(service.deriveIssueId("corpus-relica/spiral-time", 9)).toBe("spiral-time-9");
    expect(service.deriveIssueId("someone/new-repo", 1)).toBe("new-repo-1");
  });

  it("reports items that do not follow their repo's prefix or number", () => {
    expect(setup().findMisaligned()).toEqual([
      { id: "studio-7", issue_number: 3, expected_id: "studio-3" },
      { id: "studio-5", issue_number: 5, expected_id: "spiral-time-5" },
    ]);
  });
});
