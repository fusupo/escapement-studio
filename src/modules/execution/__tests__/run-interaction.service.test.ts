import { describe, expect, it } from "vitest";
import { RunInteractionService } from "../run-interaction.service.js";
import type { ExecutionDispatchNodePreview, ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-215",
    name: "Persist launch prompts for the correct work item",
    kind: "issue",
    state: "ready",
    repo: "fusupo/escapement-studio",
    issue_number: 215,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/215",
    scope_hint: "Prompt provenance",
    branch: "studio-215-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeNode(workItem: WorkItemRecord): ExecutionDispatchNodePreview {
  return {
    id: workItem.id,
    name: workItem.name,
    repo: workItem.repo,
    branch: workItem.branch ?? `${workItem.id}-branch`,
    issue_url: workItem.issue_url ?? undefined,
    scope_hint: workItem.scope_hint,
    default_base_ref: "main",
    files_owned: ["src/modules/execution/run-interaction.service.ts"],
    files_shared: [],
    files_forbidden: [],
    worktree_path: `/tmp/${workItem.id}-branch`,
    safety_checks: [],
    can_launch: true,
    issue_backed: true,
    launch_unavailable_code: null,
    launch_unavailable_reason: null,
  };
}

function makeRecentRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_recent",
    run_type: "execution",
    work_item_id: "studio-136",
    work_item_name: "Cancel work items by closing the GitHub issue",
    status: "completed",
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/136",
    branch: "studio-136-branch",
    base_ref: "main",
    worktree_path: "/tmp/studio-136-branch",
    artifact_dir: "/tmp/runs/exec_recent",
    prompt: "# Coding Phase for studio-136: Cancel work items by closing the GitHub issue",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

describe("RunInteractionService.buildPrompt", () => {
  it("builds the coding prompt from the target work item instead of the most recent run", () => {
    const workItem = makeWorkItem();
    const service = Object.create(RunInteractionService.prototype) as RunInteractionService;

    (service as any).runStore = {
      listRecentRuns: () => [makeRecentRun()],
    };

    const prompt = service.buildPrompt(workItem, makeNode(workItem));

    expect(prompt).toContain("# Coding Phase for studio-215: Persist launch prompts for the correct work item");
    expect(prompt).toContain("SCRATCHPAD_studio_215.md");
    expect(prompt).not.toContain("studio-136");
    expect(prompt).not.toContain("SCRATCHPAD_studio_136.md");
  });
});
