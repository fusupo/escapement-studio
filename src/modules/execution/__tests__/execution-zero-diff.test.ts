import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../lib/github-cli.js", () => ({
  fetchIssueBody: vi.fn(() => null),
}));

import { ExecutionService } from "../execution.service.js";
import type { ExecutionDispatchNodePreview, ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

function makeRun(artifactRoot: string, overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_zero_diff",
    run_type: "execution",
    work_item_id: "studio-270",
    work_item_name: "Zero diff suspect outcome",
    status: "queued",
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/270",
    branch: "studio-270-branch",
    base_ref: "main",
    worktree_path: join(artifactRoot, "worktree"),
    artifact_dir: join(artifactRoot, "runs", "exec_zero_diff"),
    prompt: "do the work",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function makeNode(run: ExecutionRunRecord): ExecutionDispatchNodePreview {
  return {
    id: run.work_item_id,
    name: run.work_item_name,
    repo: run.repo ?? null,
    branch: run.branch,
    issue_url: run.issue_url ?? undefined,
    scope_hint: null,
    default_base_ref: run.base_ref,
    files_owned: ["src/modules/execution/execution.service.ts"],
    files_shared: [],
    files_forbidden: [],
    worktree_path: run.worktree_path,
    safety_checks: [],
    can_launch: true,
    issue_backed: true,
    launch_unavailable_code: null,
    launch_unavailable_reason: null,
  };
}

function makeWorkItem(): WorkItemRecord {
  return {
    id: "studio-270",
    name: "Zero diff suspect outcome",
    kind: "issue",
    state: "in_progress",
    repo: "fusupo/escapement-studio",
    issue_number: 270,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/270",
    scope_hint: null,
    branch: "studio-270-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-06-10T00:00:00.000Z",
  };
}

describe("ExecutionService zero-diff terminal handling", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "execution-zero-diff-"));
    mkdirSync(join(root, "runs", "exec_zero_diff"), { recursive: true });
    mkdirSync(join(root, "worktree"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("records a suspect no-op as error, emits run.error, and suppresses RunCompletedEvent", async () => {
    const service = Object.create(ExecutionService.prototype) as any;
    const run = makeRun(root);
    const workItem = makeWorkItem();
    const appendedEvents: Array<Record<string, unknown>> = [];
    const publishedEvents: unknown[] = [];
    const updatedRuns = new Map<string, ExecutionRunRecord>([[run.run_id, run]]);

    service.readProjectContext = () => null;
    service.syncActualFiles = () => ({ ok: true, actual_files: [] });
    service.now = () => "2026-06-10T12:00:00.000Z";
    service.runStore = {
      updateRun: vi.fn((runId: string, patch: Partial<ExecutionRunRecord>) => {
        const next = { ...updatedRuns.get(runId)!, ...patch, updated_at: "2026-06-10T12:00:00.000Z" } as ExecutionRunRecord;
        updatedRuns.set(runId, next);
        return next;
      }),
      appendEvent: vi.fn((_run: ExecutionRunRecord, payload: Record<string, unknown>) => {
        appendedEvents.push(payload);
      }),
      emitRun: vi.fn(),
      getRun: vi.fn((runId: string) => updatedRuns.get(runId) ?? null),
      writeSummary: vi.fn(),
    };
    service.worktreeService = {
      createWorktree: vi.fn(),
      installDependencies: vi.fn(),
      listChangedFiles: vi.fn(() => []),
    };
    service.workItemsService = {
      get: vi.fn(() => workItem),
      update: vi.fn(),
    };
    service.runInteractionService = {
      pushActivity: vi.fn(),
      refreshChecklistAtBoundary: vi.fn(),
    };
    service.hsmService = {
      dispatch: vi.fn(async () => ({ ok: true })),
    };
    service.eventBus = {
      publish: vi.fn((event: unknown) => publishedEvents.push(event)),
    };

    await service.completeCodingRun(run.run_id, null);

    const finalRun = updatedRuns.get(run.run_id)!;
    expect(finalRun.status).toBe("error");
    expect(finalRun.terminal_outcome).toMatchObject({
      code: "no_changes_and_missing_summary",
      severity: "warn",
      changed_file_count: 0,
      summary_present: false,
    });
    expect(finalRun.result_summary).toMatch(/requires review/);
    expect(appendedEvents.at(-1)).toMatchObject({
      type: "run_suspect",
      changed_files: [],
      terminal_outcome: expect.objectContaining({ code: "no_changes_and_missing_summary" }),
    });
    expect(service.hsmService.dispatch).toHaveBeenCalledWith("studio-270", {
      type: "run.error",
      run_id: "exec_zero_diff",
      reason: expect.stringMatching(/without changing files/),
    });
    expect(publishedEvents).toEqual([]);
  });

  it("repairs a persisted false no-op when the clean branch contains commits", () => {
    const service = Object.create(ExecutionService.prototype) as any;
    const run = makeRun(root, {
      status: "error",
      phase: "failed",
      terminal_outcome: {
        code: "no_changes",
        severity: "warn",
        label: "no-op suspect",
        detail: "Execution run ended without changing files.",
        changed_file_count: 0,
        summary_present: true,
      },
      changed_files: [],
      errors: [{ code: "no_changes", message: "Execution run ended without changing files." }],
    });
    const updatedRuns = new Map<string, ExecutionRunRecord>([[run.run_id, run]]);
    const outputDir = join(run.artifact_dir, "outputs");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "response.json"),
      JSON.stringify({ assistant_text: "Implemented and committed the feature.", changed_files: [] }),
      "utf8",
    );

    service.runStore = {
      listRecentRuns: vi.fn(() => [...updatedRuns.values()]),
      updateRun: vi.fn((runId: string, patch: Partial<ExecutionRunRecord>) => {
        const next = { ...updatedRuns.get(runId)!, ...patch } as ExecutionRunRecord;
        updatedRuns.set(runId, next);
        return next;
      }),
      writeSummary: vi.fn(),
      appendEvent: vi.fn(),
    };
    service.worktreeService = {
      listChangedFiles: vi.fn(() => ["src/committed.ts", "src/other.ts"]),
    };
    service.runInteractionService = { pushActivity: vi.fn() };
    service.syncActualFiles = vi.fn(() => ({ ok: true, actual_files: ["src/committed.ts", "src/other.ts"] }));

    service.repairCommittedFalseNoopRuns();

    expect(service.worktreeService.listChangedFiles).toHaveBeenCalledWith(run.worktree_path, run.base_ref);
    expect(updatedRuns.get(run.run_id)).toMatchObject({
      status: "completed",
      phase: "completed",
      changed_files: ["src/committed.ts", "src/other.ts"],
      terminal_outcome: {
        code: "success",
        changed_file_count: 2,
        summary_present: true,
      },
      errors: [],
    });
    expect(service.runStore.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "run_outcome_recovered" }),
    );
    expect(JSON.parse(readFileSync(join(outputDir, "response.json"), "utf8"))).toMatchObject({
      changed_files: ["src/committed.ts", "src/other.ts"],
    });
  });
});
