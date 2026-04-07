import { describe, it, expect } from "vitest";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionRunRecord, ExecutionDispatchNodePreview } from "../types.js";

/**
 * We test buildScratchpad by constructing a minimal service instance via
 * Object.create so we can call the public method without wiring up DI.
 */
function callBuildScratchpad(run: ExecutionRunRecord, node: ExecutionDispatchNodePreview): string {
  const service = Object.create(ExecutionService.prototype) as ExecutionService;
  return service.buildScratchpad(run, node);
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_1234",
    run_type: "execution",
    work_item_id: "studio-42",
    work_item_name: "Add widget support",
    status: "preparing",
    created_at: "2026-04-07T00:00:00.000Z",
    updated_at: "2026-04-07T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/42",
    branch: "studio-42-branch",
    base_ref: "develop",
    worktree_path: "/tmp/worktrees/studio-42-branch",
    artifact_dir: "/tmp/artifacts/exec_1234",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function makeNode(overrides: Partial<ExecutionDispatchNodePreview> = {}): ExecutionDispatchNodePreview {
  return {
    id: "studio-42",
    name: "Add widget support",
    repo: "fusupo/escapement-studio",
    branch: "studio-42-branch",
    default_base_ref: "develop",
    files_owned: [],
    files_shared: [],
    files_forbidden: [],
    worktree_path: "/tmp/worktrees/studio-42-branch",
    safety_checks: [],
    can_launch: true,
    ...overrides,
  };
}

describe("buildScratchpad", () => {
  it("produces a markdown document with correct heading", () => {
    const md = callBuildScratchpad(makeRun(), makeNode());
    expect(md).toContain("# Scratchpad: studio-42 — Add widget support");
  });

  it("includes context fields", () => {
    const md = callBuildScratchpad(makeRun(), makeNode({ scope_hint: "Add widget rendering" }));
    expect(md).toContain("**Repo:** fusupo/escapement-studio");
    expect(md).toContain("**Issue:** https://github.com/fusupo/escapement-studio/issues/42");
    expect(md).toContain("**Branch:** studio-42-branch");
    expect(md).toContain("**Base ref:** develop");
    expect(md).toContain("**Scope hint:** Add widget rendering");
  });

  it("lists owned files", () => {
    const md = callBuildScratchpad(makeRun(), makeNode({ files_owned: ["src/widget.ts", "src/widget.test.ts"] }));
    expect(md).toContain("### Owned\n- src/widget.ts\n- src/widget.test.ts");
  });

  it("shows placeholder when no owned files", () => {
    const md = callBuildScratchpad(makeRun(), makeNode({ files_owned: [] }));
    expect(md).toContain("### Owned\n- (none predicted)");
  });

  it("lists shared files with assessment", () => {
    const md = callBuildScratchpad(
      makeRun(),
      makeNode({
        files_shared: [{ path: "src/shared.ts", assessment: "read-only", confidence: "high", notes: "" }],
      }),
    );
    expect(md).toContain("- src/shared.ts (read-only/high)");
  });

  it("lists forbidden files", () => {
    const md = callBuildScratchpad(makeRun(), makeNode({ files_forbidden: ["src/do-not-touch.ts"] }));
    expect(md).toContain("### Forbidden\n- src/do-not-touch.ts");
  });

  it("includes implementation plan section with checkboxes", () => {
    const md = callBuildScratchpad(makeRun(), makeNode());
    expect(md).toContain("## Implementation Plan");
    expect(md).toContain("- [ ] Analyze scope");
    expect(md).toContain("- [ ] Implement changes");
    expect(md).toContain("- [ ] Run tests / verify");
    expect(md).toContain("- [ ] Summarize results");
  });

  it("includes work log and blockers sections", () => {
    const md = callBuildScratchpad(makeRun(), makeNode());
    expect(md).toContain("## Work Log");
    expect(md).toContain("## Blockers");
  });

  it("handles missing optional fields gracefully", () => {
    const md = callBuildScratchpad(
      makeRun({ repo: null, issue_url: null }),
      makeNode({ scope_hint: null }),
    );
    expect(md).toContain("**Repo:** (not set)");
    expect(md).toContain("**Issue:** (not linked)");
    expect(md).toContain("**Scope hint:** (not set)");
  });
});
