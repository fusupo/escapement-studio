import { describe, expect, it, vi } from "vitest";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionRunRecord } from "../types.js";

/**
 * Phase 3 (#223) seams for RunDispositionService to mutate and emit
 * events on the ExecutionService in-memory run buffer without reaching
 * into private state. Phase 4 replaces these with RunStore methods and
 * the forwardRef(() => ExecutionService) in RunDispositionService
 * disappears.
 *
 * Tests use the Object.create(ExecutionService.prototype) harness pattern
 * established elsewhere in the execution test suite, bypassing Nest DI.
 */

interface HarnessService {
  recentRuns: ExecutionRunRecord[];
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  writeStatus: ReturnType<typeof vi.fn>;
  emitRun: ReturnType<typeof vi.fn>;
  disposeRunsForWorkItemInBuffer: ExecutionService["disposeRunsForWorkItemInBuffer"];
  emitRunExecutionResult: ExecutionService["emitRunExecutionResult"];
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_seam",
    run_type: "execution",
    work_item_id: "studio-seam",
    work_item_name: "Seam test",
    status: "completed",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "seam",
    base_ref: "develop",
    worktree_path: "",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function makeHarness(runs: ExecutionRunRecord[]): HarnessService {
  const service = Object.create(ExecutionService.prototype) as HarnessService;
  service.recentRuns = [...runs];
  service.logger = { log: vi.fn(), warn: vi.fn() };
  service.writeStatus = vi.fn();
  service.emitRun = vi.fn();
  return service;
}

describe("ExecutionService.disposeRunsForWorkItemInBuffer", () => {
  it("splices matching runs and returns newly-disposed records", () => {
    const service = makeHarness([
      makeRun({ run_id: "exec_a", work_item_id: "studio-42" }),
      makeRun({ run_id: "exec_other", work_item_id: "studio-999" }),
      makeRun({ run_id: "exec_b", work_item_id: "studio-42", status: "error" }),
    ]);

    const { newlyDisposed, alreadyDisposedIds } =
      service.disposeRunsForWorkItemInBuffer("studio-42", "2026-04-13T09:00:00.000Z");

    expect(newlyDisposed.map((r) => r.run_id).sort()).toEqual(["exec_a", "exec_b"]);
    expect(alreadyDisposedIds).toEqual([]);
    expect(service.recentRuns.map((r) => r.run_id)).toEqual(["exec_other"]);
    // writeStatus called for each newly disposed record
    expect(service.writeStatus).toHaveBeenCalledTimes(2);
    for (const call of service.writeStatus.mock.calls) {
      const run = call[0] as ExecutionRunRecord;
      expect(run.disposed_at).toBe("2026-04-13T09:00:00.000Z");
      expect(run.updated_at).toBe("2026-04-13T09:00:00.000Z");
    }
  });

  it("returns already-disposed run ids separately and does not re-stamp or call writeStatus", () => {
    const service = makeHarness([
      makeRun({
        run_id: "exec_old",
        work_item_id: "studio-42",
        disposed_at: "2026-04-01T00:00:00.000Z",
      }),
    ]);

    const { newlyDisposed, alreadyDisposedIds } =
      service.disposeRunsForWorkItemInBuffer("studio-42", "2026-04-13T09:00:00.000Z");

    expect(newlyDisposed).toEqual([]);
    expect(alreadyDisposedIds).toEqual(["exec_old"]);
    expect(service.recentRuns).toEqual([]);
    expect(service.writeStatus).not.toHaveBeenCalled();
  });

  it("swallows ENOENT from writeStatus and still treats the run as disposed", () => {
    const service = makeHarness([
      makeRun({ run_id: "exec_missing", work_item_id: "studio-42" }),
    ]);
    service.writeStatus.mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory");
      (err as Error & { code?: string }).code = "ENOENT";
      throw err;
    });

    const { newlyDisposed } = service.disposeRunsForWorkItemInBuffer(
      "studio-42",
      "2026-04-13T09:00:00.000Z",
    );

    expect(newlyDisposed.map((r) => r.run_id)).toEqual(["exec_missing"]);
    expect(service.recentRuns).toEqual([]);
    expect(service.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("failed to stamp disposed_at"),
    );
  });

  it("logs and continues on non-ENOENT writeStatus errors", () => {
    const service = makeHarness([
      makeRun({ run_id: "exec_io", work_item_id: "studio-42" }),
    ]);
    service.writeStatus.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const { newlyDisposed } = service.disposeRunsForWorkItemInBuffer(
      "studio-42",
      "2026-04-13T09:00:00.000Z",
    );

    expect(newlyDisposed.map((r) => r.run_id)).toEqual(["exec_io"]);
    expect(service.recentRuns).toEqual([]);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to stamp disposed_at for run exec_io"),
    );
  });

  it("returns empty lists when no runs match", () => {
    const service = makeHarness([
      makeRun({ run_id: "exec_other", work_item_id: "studio-999" }),
    ]);

    const { newlyDisposed, alreadyDisposedIds } =
      service.disposeRunsForWorkItemInBuffer("studio-42", "2026-04-13T09:00:00.000Z");

    expect(newlyDisposed).toEqual([]);
    expect(alreadyDisposedIds).toEqual([]);
    expect(service.recentRuns).toHaveLength(1);
  });
});

describe("ExecutionService.emitRunExecutionResult", () => {
  it("emits an execution_result event via the private emitRun helper", () => {
    const service = makeHarness([]);
    const run = makeRun({ run_id: "exec_emit", disposed_at: "2026-04-13T09:00:00.000Z" });

    service.emitRunExecutionResult(run);

    expect(service.emitRun).toHaveBeenCalledTimes(1);
    expect(service.emitRun).toHaveBeenCalledWith("execution_result", run);
  });

  it("swallows and warns when the underlying emitRun throws", () => {
    const service = makeHarness([]);
    service.emitRun.mockImplementation(() => {
      throw new Error("rxjs stream closed");
    });
    const run = makeRun({ run_id: "exec_crash" });

    expect(() => service.emitRunExecutionResult(run)).not.toThrow();
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to emit execution_result for run exec_crash"),
    );
  });
});
