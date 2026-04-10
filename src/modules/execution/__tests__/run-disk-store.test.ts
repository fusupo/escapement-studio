import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectAndMarkOrphans,
  loadRunRecordsFromDisk,
} from "../run-disk-store.js";
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
    completed_at: "2026-04-10T00:00:00.000Z",
    branch: "studio-176-branch",
    base_ref: "develop",
    worktree_path: `/tmp/worktrees/${runId}`,
    artifact_dir: `/tmp/runs/${runId}`,
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function writeRunStatus(runsDir: string, run: ExecutionRunRecord): string {
  const runDir = join(runsDir, run.run_id);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "status.json");
  writeFileSync(path, JSON.stringify(run, null, 2), "utf8");
  return path;
}

describe("loadRunRecordsFromDisk", () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "run-disk-store-"));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it("returns an empty array when the runs root does not exist", () => {
    expect(loadRunRecordsFromDisk(join(runsDir, "missing"))).toEqual([]);
  });

  it("loads every status.json and sorts by updated_at descending", () => {
    writeRunStatus(runsDir, makeRun("run_a", { updated_at: "2026-04-01T00:00:00.000Z" }));
    writeRunStatus(runsDir, makeRun("run_b", { updated_at: "2026-04-03T00:00:00.000Z" }));
    writeRunStatus(runsDir, makeRun("run_c", { updated_at: "2026-04-02T00:00:00.000Z" }));

    const records = loadRunRecordsFromDisk(runsDir);
    expect(records.map((r) => r.run_id)).toEqual(["run_b", "run_c", "run_a"]);
  });

  it("skips directories that are missing a status.json", () => {
    mkdirSync(join(runsDir, "empty_run"), { recursive: true });
    writeRunStatus(runsDir, makeRun("run_ok"));

    const records = loadRunRecordsFromDisk(runsDir);
    expect(records.map((r) => r.run_id)).toEqual(["run_ok"]);
  });

  it("skips malformed JSON without throwing and warns", () => {
    const runDir = join(runsDir, "broken_run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), "{not-json", "utf8");
    writeRunStatus(runsDir, makeRun("run_ok"));

    const warn = vi.fn();
    const records = loadRunRecordsFromDisk(runsDir, { onWarn: warn });
    expect(records.map((r) => r.run_id)).toEqual(["run_ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/malformed JSON/);
  });

  it("skips records missing required fields", () => {
    const runDir = join(runsDir, "partial");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: "partial" }), "utf8");

    const warn = vi.fn();
    const records = loadRunRecordsFromDisk(runsDir, { onWarn: warn });
    expect(records).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("detectAndMarkOrphans", () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "run-disk-orphan-"));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it("leaves terminal statuses untouched", () => {
    writeRunStatus(runsDir, makeRun("run_done", { status: "completed" }));
    writeRunStatus(runsDir, makeRun("run_err", { status: "error" }));
    writeRunStatus(runsDir, makeRun("run_blocked", { status: "blocked" }));

    const results = detectAndMarkOrphans(runsDir);
    expect(results).toEqual([]);

    for (const id of ["run_done", "run_err", "run_blocked"]) {
      const raw = JSON.parse(readFileSync(join(runsDir, id, "status.json"), "utf8"));
      // Untouched — still original updated_at.
      expect(raw.updated_at).toBe("2026-04-10T00:00:00.000Z");
    }
  });

  it.each<ExecutionRunStatus>(["queued", "preparing", "running", "disambiguating"])(
    "rewrites %s to error with an orphan activity_log entry",
    (status) => {
      writeRunStatus(runsDir, makeRun(`run_${status}`, { status }));

      const results = detectAndMarkOrphans(runsDir, { now: () => "2026-04-10T05:00:00.000Z" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ run_id: `run_${status}`, previous_status: status });

      const raw = JSON.parse(readFileSync(join(runsDir, `run_${status}`, "status.json"), "utf8")) as ExecutionRunRecord;
      expect(raw.status).toBe("error");
      expect(raw.updated_at).toBe("2026-04-10T05:00:00.000Z");
      expect(raw.progress_message).toMatch(/Orphaned by server restart/);
      expect(raw.activity_log.at(-1)?.message).toMatch(/orphaned by server restart/);
      expect(raw.errors?.some((e) => e.code === "orphaned_by_restart")).toBe(true);
    },
  );

  it("is idempotent — a second call is a no-op", () => {
    writeRunStatus(runsDir, makeRun("run_r", { status: "running" }));

    const first = detectAndMarkOrphans(runsDir, { now: () => "2026-04-10T05:00:00.000Z" });
    expect(first).toHaveLength(1);

    const second = detectAndMarkOrphans(runsDir, { now: () => "2026-04-10T06:00:00.000Z" });
    expect(second).toEqual([]);

    const raw = JSON.parse(readFileSync(join(runsDir, "run_r", "status.json"), "utf8")) as ExecutionRunRecord;
    // updated_at should still be the first rewrite timestamp.
    expect(raw.updated_at).toBe("2026-04-10T05:00:00.000Z");
  });

  it("warns and skips malformed status files", () => {
    const runDir = join(runsDir, "bad_run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), "<<<not json", "utf8");
    writeRunStatus(runsDir, makeRun("run_ok", { status: "running" }));

    const warn = vi.fn();
    const results = detectAndMarkOrphans(runsDir, { now: () => "2026-04-10T05:00:00.000Z", onWarn: warn });
    expect(results.map((r) => r.run_id)).toEqual(["run_ok"]);
    expect(warn).toHaveBeenCalled();
  });

  it("returns an empty result when the runs dir does not exist", () => {
    expect(detectAndMarkOrphans(join(runsDir, "missing"))).toEqual([]);
  });
});
