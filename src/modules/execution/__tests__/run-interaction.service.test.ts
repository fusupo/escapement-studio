import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("RunInteractionService.executeFollowUpTurn", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "run-interaction-follow-up-"));
    mkdirSync(join(root, "worktree"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("classifies a zero-diff follow-up as suspect and dispatches run.error", async () => {
    const service = Object.create(RunInteractionService.prototype) as any;
    const run = makeRecentRun({
      run_id: "exec_follow_up",
      status: "completed",
      work_item_id: "studio-270",
      worktree_path: join(root, "worktree"),
      artifact_dir: join(root, "runs", "exec_follow_up"),
    });
    const finalRuns = new Map<string, ExecutionRunRecord>([[run.run_id, run]]);
    const appendedEvents: Array<Record<string, unknown>> = [];

    service.logger = { warn: vi.fn() };
    service.now = () => "2026-06-10T13:00:00.000Z";
    service.pushActivity = vi.fn();
    service.createSession = vi.fn(async () => ({
      modelFallbackMessage: null,
      session: {
        subscribe: () => () => {},
        prompt: async () => {},
        getLastAssistantText: () => null,
        dispose: () => {},
      },
    }));
    service.activeSessions = new Map();
    service.handleSessionEvent = vi.fn();
    service.runStore = {
      updateRun: vi.fn((runId: string, patch: Partial<ExecutionRunRecord>) => {
        const next = { ...finalRuns.get(runId)!, ...patch, updated_at: "2026-06-10T13:00:00.000Z" } as ExecutionRunRecord;
        finalRuns.set(runId, next);
        return next;
      }),
      writeSummary: vi.fn(),
      appendEvent: vi.fn((_run: ExecutionRunRecord, payload: Record<string, unknown>) => {
        appendedEvents.push(payload);
      }),
    };
    service.scratchpadService = {
      syncScratchpadToCanonical: vi.fn(),
      emitChecklistIfChanged: vi.fn(),
    };
    service.worktreeService = {
      listChangedFiles: vi.fn(() => []),
    };
    service.syncActualFiles = vi.fn(() => ({ ok: true, actual_files: [] }));
    service.workItemsService = {
      get: vi.fn(() => ({ id: "studio-270", state: "in_progress" })),
      update: vi.fn(),
    };
    service.hsmService = {
      dispatch: vi.fn(async () => ({ ok: true })),
    };

    await service.executeFollowUpTurn(run, "please retry");

    const finalRun = finalRuns.get(run.run_id)!;
    expect(finalRun.status).toBe("error");
    expect(finalRun.terminal_outcome).toMatchObject({
      code: "no_changes_and_missing_summary",
      severity: "warn",
    });
    expect(appendedEvents.at(-1)).toMatchObject({
      type: "follow_up_turn_suspect",
      terminal_outcome: expect.objectContaining({ code: "no_changes_and_missing_summary" }),
    });
    expect(service.hsmService.dispatch).toHaveBeenCalledWith("studio-270", {
      type: "run.error",
      run_id: "exec_follow_up",
      reason: expect.stringMatching(/without changing files/),
    });
  });
});
