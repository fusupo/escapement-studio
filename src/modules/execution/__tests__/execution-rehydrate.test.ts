import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionRunRecord, ExecutionRunStatus } from "../types.js";

function makeRun(runId: string, overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: runId,
    run_type: "execution",
    work_item_id: "studio-176",
    work_item_name: "Work item reconciler",
    status: "completed",
    created_at: "2026-04-10T00:00:00.000Z",
    updated_at: "2026-04-10T00:00:00.000Z",
    completed_at: "2026-04-10T00:05:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/176",
    branch: "studio-176-branch",
    base_ref: "develop",
    worktree_path: "/tmp/worktrees/studio-176-branch",
    artifact_dir: `/tmp/runs/${runId}`,
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function writeRun(runsDir: string, run: ExecutionRunRecord): void {
  const dir = join(runsDir, run.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
}

describe("ExecutionService.hydrateRecentRunsFromDisk", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "exec-rehydrate-"));
    mkdirSync(join(artifactRoot, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  function makeServiceWithEmptyBuffer(): ExecutionService {
    const service = Object.create(ExecutionService.prototype) as ExecutionService;
    (service as any).logger = { log: vi.fn(), warn: vi.fn() };
    (service as any).artifactRoot = artifactRoot;
    (service as any).recentRuns = [];
    (service as any).recentRunLimit = 16;
    return service;
  }

  it("loads completed runs from disk into recentRuns sorted newest-first", () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_a", { updated_at: "2026-04-01T00:00:00.000Z" }));
    writeRun(runsDir, makeRun("run_b", { updated_at: "2026-04-03T00:00:00.000Z" }));
    writeRun(runsDir, makeRun("run_c", { updated_at: "2026-04-02T00:00:00.000Z" }));

    const service = makeServiceWithEmptyBuffer();
    service.hydrateRecentRunsFromDisk();

    expect((service as any).recentRuns.map((r: ExecutionRunRecord) => r.run_id)).toEqual([
      "run_b",
      "run_c",
      "run_a",
    ]);
  });

  it("dedupes by run_id when the in-memory buffer already has an entry", () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_a"));

    const service = makeServiceWithEmptyBuffer();
    (service as any).recentRuns.push(makeRun("run_a", { progress_message: "already-tracked" }));
    service.hydrateRecentRunsFromDisk();

    const runs = (service as any).recentRuns as ExecutionRunRecord[];
    expect(runs).toHaveLength(1);
    // In-memory entry wins — disk copy does not overwrite live state.
    expect(runs[0].progress_message).toBe("already-tracked");
  });

  it("respects recentRunLimit and keeps the newest entries", () => {
    const runsDir = join(artifactRoot, "runs");
    for (let i = 0; i < 20; i += 1) {
      writeRun(
        runsDir,
        makeRun(`run_${String(i).padStart(2, "0")}`, {
          updated_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
      );
    }

    const service = makeServiceWithEmptyBuffer();
    service.hydrateRecentRunsFromDisk();

    const runs = (service as any).recentRuns as ExecutionRunRecord[];
    expect(runs).toHaveLength(16);
    expect(runs[0].run_id).toBe("run_19");
    expect(runs.at(-1)?.run_id).toBe("run_04");
  });

  it("rehydrates completed and errored runs, while filtering disposed and malformed ones", () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_completed", {
      updated_at: "2026-04-03T00:00:00.000Z",
      result_summary: "done",
      changed_files: ["src/a.ts"],
      pull_request: {
        number: 130,
        url: "https://github.com/fusupo/escapement-studio/pull/130",
        title: "feat: persist execution runs",
        body: "Body",
        base_ref: "develop",
        head_ref: "studio-130-branch",
        is_draft: false,
        created_at: "2026-04-03T00:00:00.000Z",
      },
    }));
    writeRun(runsDir, makeRun("run_error", {
      status: "error",
      updated_at: "2026-04-02T00:00:00.000Z",
      errors: [{ code: "boom", message: "boom" }],
    }));
    writeRun(runsDir, makeRun("run_disposed", {
      updated_at: "2026-04-04T00:00:00.000Z",
      disposed_at: "2026-04-04T00:10:00.000Z",
    }));
    const malformedDir = join(runsDir, "run_malformed");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, "status.json"), JSON.stringify({ run_id: "run_malformed" }), "utf8");

    const service = makeServiceWithEmptyBuffer();
    service.hydrateRecentRunsFromDisk();

    const runs = (service as any).recentRuns as ExecutionRunRecord[];
    expect(runs.map((run) => run.run_id)).toEqual(["run_completed", "run_error"]);
    expect(runs[0].result_summary).toBe("done");
    expect(runs[0].changed_files).toEqual(["src/a.ts"]);
    expect(runs[0].pull_request?.number).toBe(130);
    expect(runs[1].errors).toEqual([{ code: "boom", message: "boom" }]);
  });

  it("is a no-op when the runs dir does not exist", () => {
    rmSync(join(artifactRoot, "runs"), { recursive: true, force: true });
    const service = makeServiceWithEmptyBuffer();
    service.hydrateRecentRunsFromDisk();
    expect((service as any).recentRuns).toEqual([]);
  });
});

describe("ExecutionService.onModuleInit", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "exec-onmoduleinit-"));
    mkdirSync(join(artifactRoot, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("runs the startup reconcile then rehydrates recentRuns from the rewritten disk state", async () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_completed", { status: "completed" }));
    writeRun(runsDir, makeRun("run_running", { status: "running" as ExecutionRunStatus }));

    const reconcilerStub = {
      runStartupReconcile: vi.fn(async () => {
        const rewritten = {
          ...makeRun("run_running", {
            status: "running" as ExecutionRunStatus,
            updated_at: "2026-04-10T00:00:00.000Z",
          }),
          status: "error",
          updated_at: "2026-04-10T05:00:00.000Z",
          completed_at: "2026-04-10T05:00:00.000Z",
          progress_message: 'Orphaned by server restart at 2026-04-10T05:00:00.000Z (was "running").',
          result_summary: "Orphaned by server restart at 2026-04-10T05:00:00.000Z.",
          activity_log: [{
            timestamp: "2026-04-10T05:00:00.000Z",
            kind: "status_change",
            message: "orphaned by server restart at 2026-04-10T05:00:00.000Z",
          }],
          errors: [{
            code: "orphaned_by_restart",
            message: 'Run was in status "running" when the Studio server restarted and could not be resumed.',
          }],
        } satisfies ExecutionRunRecord;
        writeRun(runsDir, rewritten);
        return {
          reconciled: [],
          orphans: [{ run_id: "run_running", previous_status: "running", rewritten_at: "2026-04-10T05:00:00.000Z" }],
          summary: { total: 0, orphans_rewritten: 1, next_actions: {} as any, generated_at: "" },
        };
      }),
    };

    const service = Object.create(ExecutionService.prototype) as ExecutionService;
    (service as any).logger = { log: vi.fn(), warn: vi.fn() };
    (service as any).artifactRoot = artifactRoot;
    (service as any).recentRuns = [];
    (service as any).recentRunLimit = 16;
    (service as any).workItemReconciler = reconcilerStub;
    (service as any).hsmService = { registerActionHandler: vi.fn() };

    await service.onModuleInit();

    expect(reconcilerStub.runStartupReconcile).toHaveBeenCalledTimes(1);
    const runs = (service as any).recentRuns as ExecutionRunRecord[];
    expect(runs.map((r) => r.run_id)).toEqual(["run_running", "run_completed"]);
    expect(runs[0]).toMatchObject({
      run_id: "run_running",
      status: "error",
      progress_message: expect.stringMatching(/Orphaned by server restart/),
      result_summary: expect.stringMatching(/Orphaned by server restart/),
      errors: [expect.objectContaining({ code: "orphaned_by_restart" })],
    });
  });

  it("swallows reconcile errors and still rehydrates", async () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_completed", { status: "completed" }));

    const logger = { log: vi.fn(), warn: vi.fn() };
    const service = Object.create(ExecutionService.prototype) as ExecutionService;
    (service as any).logger = logger;
    (service as any).artifactRoot = artifactRoot;
    (service as any).recentRuns = [];
    (service as any).recentRunLimit = 16;
    (service as any).workItemReconciler = {
      runStartupReconcile: vi.fn(async () => {
        throw new Error("reconciler boom");
      }),
    };
    (service as any).hsmService = { registerActionHandler: vi.fn() };

    await service.onModuleInit();

    expect(logger.warn).toHaveBeenCalled();
    expect((service as any).recentRuns).toHaveLength(1);
  });
});
