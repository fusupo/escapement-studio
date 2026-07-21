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

  it("skips records with unknown statuses", () => {
    const runDir = join(runsDir, "weird_status");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), JSON.stringify({
      ...makeRun("weird_status"),
      status: "mystery_state",
    }), "utf8");

    const warn = vi.fn();
    const records = loadRunRecordsFromDisk(runsDir, { onWarn: warn });
    expect(records).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not match ExecutionRunRecord shape/));
  });

  it("filters disposed runs by default but can include them explicitly", () => {
    writeRunStatus(runsDir, makeRun("run_live", { updated_at: "2026-04-10T01:00:00.000Z" }));
    writeRunStatus(runsDir, makeRun("run_disposed", {
      updated_at: "2026-04-10T02:00:00.000Z",
      disposed_at: "2026-04-10T03:00:00.000Z",
    }));

    expect(loadRunRecordsFromDisk(runsDir).map((record) => record.run_id)).toEqual(["run_live"]);
    expect(loadRunRecordsFromDisk(runsDir, { includeDisposed: true }).map((record) => record.run_id)).toEqual([
      "run_disposed",
      "run_live",
    ]);
  });

  it("sanitizes optional persisted fields while preserving completed-run metadata", () => {
    writeRunStatus(runsDir, makeRun("run_completed", {
      result_summary: "Finished successfully.",
      terminal_outcome: {
        code: "success",
        severity: "success",
        label: "completed",
        detail: "Execution run completed with 2 changed file(s) and an assistant summary.",
        changed_file_count: 2,
        summary_present: true,
      },
      changed_files: ["src/a.ts", 123 as unknown as string, "src/b.ts"],
      activity_log: [
        { timestamp: "2026-04-10T00:00:00.000Z", kind: "agent_message", message: "hello" },
        { nope: true } as unknown as ExecutionRunRecord["activity_log"][number],
      ],
      pull_request: {
        number: 130,
        url: "https://github.com/fusupo/escapement-studio/pull/130",
        title: "feat: persist runs",
        body: "Body",
        base_ref: "develop",
        head_ref: "studio-130-branch",
        is_draft: false,
        created_at: "2026-04-10T00:00:00.000Z",
      },
      errors: [
        { code: "kept", message: "kept" },
        { code: 42, message: null } as unknown as NonNullable<ExecutionRunRecord["errors"]>[number],
      ],
      checklist: {
        run_id: "run_completed",
        revision: 3,
        updated_at: "2026-04-10T00:03:00.000Z",
        items: [
          { text: "Implemented", checked: true, category: "implementation" },
          { text: "Accepted", checked: false, category: "acceptance" },
          { text: "bad", checked: "yes", category: "verification" } as any,
        ],
        completed: 99,
        total: 99,
      },
    }));

    const [record] = loadRunRecordsFromDisk(runsDir);
    expect(record.result_summary).toBe("Finished successfully.");
    expect(record.terminal_outcome).toMatchObject({
      code: "success",
      changed_file_count: 2,
      summary_present: true,
    });
    expect(record.changed_files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(record.activity_log).toEqual([
      { timestamp: "2026-04-10T00:00:00.000Z", kind: "agent_message", message: "hello", detail: undefined },
    ]);
    expect(record.pull_request?.number).toBe(130);
    expect(record.errors).toEqual([{ code: "kept", message: "kept" }]);
    expect(record.checklist).toEqual({
      run_id: "run_completed",
      revision: 3,
      updated_at: "2026-04-10T00:03:00.000Z",
      items: [
        { text: "Implemented", checked: true, category: "implementation" },
        { text: "Accepted", checked: false, category: "acceptance" },
      ],
      completed: 1,
      total: 1,
    });
  });

  it.each([
    { revision: 0, updated_at: "2026-04-10T00:03:00.000Z", run_id: "run_bad" },
    { revision: 1, updated_at: "not-a-date", run_id: "run_bad" },
    { revision: 1, updated_at: "2026-04-10T00:03:00.000Z", run_id: "other-run" },
  ])("discards malformed optional checklist metadata without rejecting the run: %j", (metadata) => {
    writeRunStatus(runsDir, makeRun("run_bad", {
      checklist: {
        ...metadata,
        items: [],
        completed: 0,
        total: 0,
      } as ExecutionRunRecord["checklist"],
    }));

    const [record] = loadRunRecordsFromDisk(runsDir);
    expect(record.run_id).toBe("run_bad");
    expect(record.checklist).toBeUndefined();
  });

  it("keeps legacy records that have no checklist snapshot", () => {
    writeRunStatus(runsDir, makeRun("run_legacy"));
    expect(loadRunRecordsFromDisk(runsDir)[0].checklist).toBeUndefined();
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

  it.each<ExecutionRunStatus>(["queued", "preparing", "running"])(
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

  it("preserves the durable execution-confirmation gate across a restart", () => {
    writeRunStatus(runsDir, makeRun("run_confirmation", {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [{ id: "question-1", kind: "question", prompt: "Which API should be used?", response: null }],
        started_at: "2026-04-10T00:00:00.000Z",
        refined_at: "2026-04-10T00:01:00.000Z",
      },
    }));

    expect(detectAndMarkOrphans(runsDir)).toEqual([]);

    const [rehydrated] = loadRunRecordsFromDisk(runsDir);
    expect(rehydrated).toMatchObject({
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [{ id: "question-1", prompt: "Which API should be used?" }],
      },
    });
  });

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
