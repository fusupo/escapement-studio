import { describe, expect, it } from "vitest";
import { parseIssueReferences } from "../issue-reference-parser.js";

const REPO = "fusupo/escapement-studio";
const parse = (body: string) => parseIssueReferences(body, REPO);
const brief = (body: string) => parse(body).map((ref) =>
  `${ref.direction === "outgoing" ? "" : "<-"}${ref.rel}:${ref.work_item_id ?? `${ref.repo}#${ref.issue_number}`}`);

describe("parseIssueReferences (#281)", () => {
  it("reads dependency statements", () => {
    expect(brief("Depends on #12.\nBlocked by #13 and #14\nrequires: #15")).toEqual([
      `depends_on:${REPO}#12`, `depends_on:${REPO}#13`, `depends_on:${REPO}#14`, `depends_on:${REPO}#15`,
    ]);
  });

  it("reads containment statements", () => {
    expect(brief("Part of #20\nParent: #21\nSub-issue of #22, child of #23\nEpic: #24\nParent issue #25")).toEqual(
      [20, 21, 22, 23, 24, 25].map((n) => `is_part_of:${REPO}#${n}`),
    );
  });

  it("reads the reverse direction from 'blocks' and task lists", () => {
    expect(brief("Blocks #30\n- [ ] #31\n* [x] #32 done already")).toEqual([
      `<-depends_on:${REPO}#30`, `<-is_part_of:${REPO}#31`, `<-is_part_of:${REPO}#32`,
    ]);
  });

  it("resolves cross-repo references, issue URLs and literal work-item IDs", () => {
    expect(brief("depends on other/repo#4, https://github.com/a/b/issues/9 and studio-180")).toEqual([
      "depends_on:other/repo#4", "depends_on:a/b#9", "depends_on:studio-180",
    ]);
  });

  it("keeps the line as evidence, trimmed and capped", () => {
    expect(parse("  - This work depends on #12 landing first.  ")[0].quote).toBe("- This work depends on #12 landing first.");
    expect(parse(`depends on #1 ${"x".repeat(400)}`)[0].quote).toHaveLength(200);
  });

  it("does not read bare mentions, prose, or code", () => {
    expect(parse("See #12 and #13. Related: #14.\nThis is part of the plan.\nIt requires care.\n```\ndepends on #99\n```\nfixes #5")).toEqual([]);
    expect(parse("independent of #12; unblocks #13")).toEqual([]);
  });

  it("reports each relationship once", () => {
    expect(brief("Depends on #12\n\n## Notes\ndepends on #12 (again)\npart of #12")).toEqual([
      `depends_on:${REPO}#12`, `is_part_of:${REPO}#12`,
    ]);
  });

  it("handles an empty body", () => {
    expect(parseIssueReferences(null, REPO)).toEqual([]);
    expect(parse("")).toEqual([]);
  });
});
