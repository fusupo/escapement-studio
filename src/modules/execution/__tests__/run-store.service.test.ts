import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { RunStore } from "../run-store.service.js";
import type { ActivityLogEntry, ChecklistItem, ExecutionRunRecord } from "../types.js";

/**
 * Phase 4a (#230): direct coverage for RunStore, the newly-extracted
 * owner of the in-memory run buffer + disk primitives + SSE stream.
 * Uses the Object.create(RunStore.prototype) harness pattern to
 * bypass Nest DI — RunStore takes no injected dependencies, so the
 * only fields the tests need to poke are `recentRuns`,
 * `recentRunLimit`, `artifactRoot`, `logger`, `eventSubject`,
 * `eventCounter`, `streamId`.
 */

interface HarnessStore {
  recentRuns: ExecutionRunRecord[];
  recentRunLimit: number;
  artifactRoot: string;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  eventSubject: import("rxjs").Subject<import("@nestjs/common").MessageEvent>;
  eventCounter: number;
  streamId: string;
  // Methods under test via prototype
  listRecentRuns: RunStore["listRecentRuns"];
  getRun: RunStore["getRun"];
  upsertRecentRun: RunStore["upsertRecentRun"];
  updateRun: RunStore["updateRun"];
  hydrateRecentRunsFromDisk: RunStore["hydrateRecentRunsFromDisk"];
  persistRun: RunStore["persistRun"];
  persistChecklistProjection: RunStore["persistChecklistProjection"];
  writeStatus: RunStore["writeStatus"];
  writeMetadata: RunStore["writeMetadata"];
  writeSummary: RunStore["writeSummary"];
  appendEvent: RunStore["appendEvent"];
  emitRun: RunStore["emitRun"];
  emitEvent: RunStore["emitEvent"];
  appendActivityLog: RunStore["appendActivityLog"];
  disposeRunsForWorkItem: RunStore["disposeRunsForWorkItem"];
  captureRunSnapshotForWorkItem: RunStore["captureRunSnapshotForWorkItem"];
  stream: RunStore["stream"];
}

function makeStore(artifactRoot: string, runs: ExecutionRunRecord[] = []): HarnessStore {
  // Use `new RunStore()` so rxjs Subject + Logger initialize properly.
  // Override artifactRoot + seed recentRuns via casts.
  const store = new RunStore() as unknown as HarnessStore;
  (store as any).artifactRoot = artifactRoot;
  store.recentRuns.length = 0;
  for (const run of runs) {
    store.recentRuns.push(run);
  }
  return store;
}

function makeRun(runId: string, overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: runId,
    run_type: "execution",
    work_item_id: "studio-230",
    work_item_name: "Phase 4a RunStore test",
    status: "completed",
    created_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/230",
    branch: "230-phase-4a",
    base_ref: "develop",
    worktree_path: "",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function writeRunToDisk(artifactRoot: string, run: ExecutionRunRecord): string {
  const dir = join(artifactRoot, "runs", run.run_id);
  mkdirSync(dir, { recursive: true });
  const runWithDir = { ...run, artifact_dir: dir };
  writeFileSync(join(dir, "status.json"), JSON.stringify(runWithDir, null, 2), "utf8");
  return dir;
}

describe("RunStore", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "run-store-test-"));
    mkdirSync(join(artifactRoot, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  describe("buffer operations", () => {
    it("upsertRecentRun inserts a new run at the front", () => {
      const store = makeStore(artifactRoot);
      store.upsertRecentRun(makeRun("run_a"));
      expect(store.recentRuns.map((r) => r.run_id)).toEqual(["run_a"]);
    });

    it("upsertRecentRun updates an existing run in place without changing order", () => {
      const store = makeStore(artifactRoot, [
        makeRun("run_a", { progress_message: "first" }),
        makeRun("run_b"),
      ]);
      store.upsertRecentRun(makeRun("run_a", { progress_message: "second" }));
      expect(store.recentRuns.map((r) => r.run_id)).toEqual(["run_a", "run_b"]);
      expect(store.recentRuns[0].progress_message).toBe("second");
    });

    it("upsertRecentRun respects the buffer cap when inserting new runs", () => {
      const store = makeStore(artifactRoot);
      for (let i = 0; i < 20; i += 1) {
        store.upsertRecentRun(makeRun(`run_${String(i).padStart(2, "0")}`));
      }
      expect(store.recentRuns.length).toBe(16);
      // Most-recent insertion lives at index 0
      expect(store.recentRuns[0].run_id).toBe("run_19");
    });

    it("getRun returns the matching run or null", () => {
      const store = makeStore(artifactRoot, [makeRun("run_a")]);
      expect(store.getRun("run_a")?.run_id).toBe("run_a");
      expect(store.getRun("run_missing")).toBeNull();
    });

    it("listRecentRuns returns a copy sorted by updated_at descending", () => {
      const store = makeStore(artifactRoot, [
        makeRun("run_a", { updated_at: "2026-04-01T00:00:00.000Z" }),
        makeRun("run_b", { updated_at: "2026-04-03T00:00:00.000Z" }),
        makeRun("run_c", { updated_at: "2026-04-02T00:00:00.000Z" }),
      ]);
      const sorted = store.listRecentRuns();
      expect(sorted.map((r) => r.run_id)).toEqual(["run_b", "run_c", "run_a"]);
      // Returned array is a copy — mutations don't affect internal state
      sorted.pop();
      expect(store.recentRuns.length).toBe(3);
    });

    it("updateRun merges a patch, stamps updated_at, writes status, and emits", () => {
      // Use a running status so the emission is `execution_status`
      // (terminal statuses emit `execution_result` — covered below).
      const run = makeRun("run_a", {
        status: "running",
        artifact_dir: join(artifactRoot, "runs", "run_a"),
      });
      mkdirSync(run.artifact_dir, { recursive: true });
      const store = makeStore(artifactRoot, [run]);
      const emitSpy = vi.spyOn(store, "emitRun");
      const writeSpy = vi.spyOn(store, "writeStatus");

      const next = store.updateRun("run_a", { progress_message: "progressing" });

      expect(next?.progress_message).toBe("progressing");
      expect(next?.updated_at).not.toBe("2026-04-13T00:00:00.000Z");
      expect(writeSpy).toHaveBeenCalledWith(next);
      expect(emitSpy).toHaveBeenCalledWith("execution_status", next);
    });

    it("updateRun emits execution_result for terminal states", () => {
      const run = makeRun("run_a", { artifact_dir: join(artifactRoot, "runs", "run_a") });
      mkdirSync(run.artifact_dir, { recursive: true });
      const store = makeStore(artifactRoot, [run]);
      const emitSpy = vi.spyOn(store, "emitRun");

      store.updateRun("run_a", { status: "completed" });

      expect(emitSpy).toHaveBeenCalledWith("execution_result", expect.objectContaining({ status: "completed" }));
    });

    it("updateRun returns null when run_id is not in the buffer", () => {
      const store = makeStore(artifactRoot);
      expect(store.updateRun("run_missing", { progress_message: "ghost" })).toBeNull();
    });
  });

  describe("hydrateRecentRunsFromDisk", () => {
    it("loads runs from disk sorted newest-first", () => {
      writeRunToDisk(artifactRoot, makeRun("run_a", { updated_at: "2026-04-01T00:00:00.000Z" }));
      writeRunToDisk(artifactRoot, makeRun("run_b", { updated_at: "2026-04-03T00:00:00.000Z" }));
      writeRunToDisk(artifactRoot, makeRun("run_c", { updated_at: "2026-04-02T00:00:00.000Z" }));

      const store = makeStore(artifactRoot);
      store.hydrateRecentRunsFromDisk();

      expect(store.recentRuns.map((r) => r.run_id)).toEqual(["run_b", "run_c", "run_a"]);
    });

    it("dedupes by run_id — in-memory entry wins", () => {
      writeRunToDisk(artifactRoot, makeRun("run_a", { progress_message: "from-disk" }));
      const store = makeStore(artifactRoot, [
        makeRun("run_a", { progress_message: "in-memory-wins" }),
      ]);
      store.hydrateRecentRunsFromDisk();

      expect(store.recentRuns.length).toBe(1);
      expect(store.recentRuns[0].progress_message).toBe("in-memory-wins");
    });

    it("respects recentRunLimit and keeps the newest entries", () => {
      for (let i = 0; i < 20; i += 1) {
        writeRunToDisk(
          artifactRoot,
          makeRun(`run_${String(i).padStart(2, "0")}`, {
            updated_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          }),
        );
      }
      const store = makeStore(artifactRoot);
      store.hydrateRecentRunsFromDisk();

      expect(store.recentRuns.length).toBe(16);
      expect(store.recentRuns[0].run_id).toBe("run_19");
      expect(store.recentRuns.at(-1)?.run_id).toBe("run_04");
    });
  });

  describe("persistChecklistProjection", () => {
    const pending: ChecklistItem[] = [
      { text: "Implement it", checked: false, category: "implementation" },
      { text: "Verify it", checked: false, category: "verification" },
    ];

    function checklistStore(existing?: ExecutionRunRecord["checklist"]) {
      const artifactDir = join(artifactRoot, "runs", "run_checklist");
      mkdirSync(artifactDir, { recursive: true });
      return makeStore(artifactRoot, [makeRun("run_checklist", { artifact_dir: artifactDir, checklist: existing })]);
    }

    it("starts at revision 1 and increments sequential content changes", () => {
      const store = checklistStore();

      const first = store.persistChecklistProjection("run_checklist", pending);
      const second = store.persistChecklistProjection("run_checklist", [
        { ...pending[0], checked: true },
        pending[1],
      ]);

      expect(first).toMatchObject({ revision: 1, completed: 0, total: 1 });
      expect(first?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(second).toMatchObject({ revision: 2, completed: 1, total: 1 });
    });

    it("deduplicates identical projections using the freshest buffered record", () => {
      const existing = {
        run_id: "run_checklist",
        revision: 7,
        updated_at: "2026-04-13T01:00:00.000Z",
        items: pending,
        completed: 0,
        total: 1,
      };
      const store = checklistStore(existing);
      const writeSpy = vi.spyOn(store, "writeStatus");
      const emitSpy = vi.spyOn(store, "emitEvent");

      const result = store.persistChecklistProjection("run_checklist", pending);

      expect(result).toBe(existing);
      expect(result?.revision).toBe(7);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("persists the replacement before publishing it", () => {
      const store = checklistStore();
      const writeSpy = vi.spyOn(store, "writeStatus");
      const emitSpy = vi.spyOn(store, "emitEvent");

      const result = store.persistChecklistProjection("run_checklist", pending);

      expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({ checklist: result }));
      expect(writeSpy.mock.invocationCallOrder[0]).toBeLessThan(emitSpy.mock.invocationCallOrder[0]);
      const persisted = JSON.parse(readFileSync(join(artifactRoot, "runs", "run_checklist", "status.json"), "utf8"));
      expect(persisted.checklist).toEqual(result);
    });

    it("does not mutate the buffer or publish when persistence fails", () => {
      const store = checklistStore();
      vi.spyOn(store, "writeStatus").mockImplementation(() => { throw new Error("disk full"); });
      const emitSpy = vi.spyOn(store, "emitEvent");

      expect(() => store.persistChecklistProjection("run_checklist", pending)).toThrow("disk full");
      expect(store.getRun("run_checklist")?.checklist).toBeUndefined();
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("can republish an unchanged durable snapshot without changing metadata", () => {
      const store = checklistStore();
      const first = store.persistChecklistProjection("run_checklist", pending)!;
      const emitSpy = vi.spyOn(store, "emitEvent");
      const writeSpy = vi.spyOn(store, "writeStatus");

      const repeated = store.persistChecklistProjection("run_checklist", pending, { republishUnchanged: true });

      expect(repeated).toEqual(first);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith("execution_checklist", "run_checklist", first);
    });

    it("returns null for a run outside the current buffer", () => {
      expect(makeStore(artifactRoot).persistChecklistProjection("missing", pending)).toBeNull();
    });
  });

  describe("persistRun", () => {
    it("creates artifact dirs, writes metadata and status, appends event, and emits", () => {
      const run = makeRun("run_persist", {
        artifact_dir: join(artifactRoot, "runs", "run_persist"),
      });
      const store = makeStore(artifactRoot);
      const emitSpy = vi.spyOn(store, "emitRun");

      store.persistRun(run);

      expect(existsSync(join(run.artifact_dir, "outputs"))).toBe(true);
      expect(existsSync(join(run.artifact_dir, "metadata.json"))).toBe(true);
      expect(existsSync(join(run.artifact_dir, "status.json"))).toBe(true);
      expect(existsSync(join(run.artifact_dir, "events.jsonl"))).toBe(true);
      expect(store.recentRuns[0].run_id).toBe("run_persist");
      expect(emitSpy).toHaveBeenCalledWith("execution_status", run);
    });

    it("emits execution_result when the initial status is blocked", () => {
      const run = makeRun("run_blocked", {
        status: "blocked",
        artifact_dir: join(artifactRoot, "runs", "run_blocked"),
      });
      const store = makeStore(artifactRoot);
      const emitSpy = vi.spyOn(store, "emitRun");

      store.persistRun(run);

      expect(emitSpy).toHaveBeenCalledWith("execution_result", run);
    });
  });

  describe("disposeRunsForWorkItem", () => {
    it("splices matching buffered runs, stamps disposed_at, and emits execution_result", () => {
      const runs = [
        makeRun("run_a", { artifact_dir: join(artifactRoot, "runs", "run_a") }),
        makeRun("run_other", { work_item_id: "studio-999", artifact_dir: join(artifactRoot, "runs", "run_other") }),
        makeRun("run_c", { status: "error", artifact_dir: join(artifactRoot, "runs", "run_c") }),
      ];
      for (const run of runs) mkdirSync(run.artifact_dir, { recursive: true });
      const store = makeStore(artifactRoot, runs);
      const emitSpy = vi.spyOn(store, "emitRun");

      const removed = store.disposeRunsForWorkItem(
        "studio-230",
        () => "2026-04-13T12:00:00.000Z",
      );

      expect(removed.sort()).toEqual(["run_a", "run_c"]);
      expect(store.recentRuns.map((r) => r.run_id)).toEqual(["run_other"]);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it("is idempotent for already-disposed runs (spliced but not re-stamped)", () => {
      const store = makeStore(artifactRoot, [
        makeRun("run_old", { disposed_at: "2026-04-01T00:00:00.000Z" }),
      ]);
      const writeSpy = vi.spyOn(store, "writeStatus");
      const emitSpy = vi.spyOn(store, "emitRun");

      const removed = store.disposeRunsForWorkItem("studio-230", () => "2026-04-13T00:00:00.000Z");

      expect(removed).toEqual(["run_old"]);
      expect(store.recentRuns).toEqual([]);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("includes on-disk runs not in the buffer in the returned ID set", () => {
      writeRunToDisk(artifactRoot, makeRun("run_on_disk"));
      const store = makeStore(artifactRoot);

      const removed = store.disposeRunsForWorkItem("studio-230", () => "2026-04-13T00:00:00.000Z");

      expect(removed).toContain("run_on_disk");
      // The disk record was updated with disposed_at
      const persisted = JSON.parse(
        readFileSync(join(artifactRoot, "runs", "run_on_disk", "status.json"), "utf8"),
      );
      expect(persisted.disposed_at).toBe("2026-04-13T00:00:00.000Z");
    });

    it("swallows ENOENT from writeStatus and still treats the run as disposed", () => {
      const run = makeRun("run_missing_file", {
        artifact_dir: join(artifactRoot, "runs", "run_missing_file"),
      });
      const store = makeStore(artifactRoot, [run]);
      // Don't mkdir the artifact dir — writeStatus will ENOENT.
      const loggerSpy = vi.spyOn(store.logger, "warn");

      const removed = store.disposeRunsForWorkItem("studio-230", () => "2026-04-13T00:00:00.000Z");

      expect(removed).toEqual(["run_missing_file"]);
      expect(store.recentRuns).toEqual([]);
      // No warning logged for missing-file case
      expect(loggerSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("failed to stamp disposed_at for run run_missing_file"),
      );
    });
  });

  describe("captureRunSnapshotForWorkItem", () => {
    it("merges buffered and on-disk runs, deduped in-memory-wins", () => {
      const inMemory = makeRun("run_both", {
        artifact_dir: join(artifactRoot, "runs", "run_both"),
        progress_message: "in-memory-wins",
      });
      writeRunToDisk(artifactRoot, makeRun("run_both", { progress_message: "from-disk" }));
      writeRunToDisk(artifactRoot, makeRun("run_disk_only", { work_item_id: "studio-230" }));

      const store = makeStore(artifactRoot, [inMemory]);
      const snapshot = store.captureRunSnapshotForWorkItem("studio-230");

      const ids = snapshot.map((r) => r.run_id).sort();
      expect(ids).toEqual(["run_both", "run_disk_only"]);
      const bothRun = snapshot.find((r) => r.run_id === "run_both");
      expect(bothRun?.progress_message).toBe("in-memory-wins");
    });

    it("returns only runs matching the workItemId", () => {
      const store = makeStore(artifactRoot, [
        makeRun("run_match"),
        makeRun("run_other", { work_item_id: "studio-999" }),
      ]);
      const snapshot = store.captureRunSnapshotForWorkItem("studio-230");
      expect(snapshot.map((r) => r.run_id)).toEqual(["run_match"]);
    });

    it("includes a disposed terminal run for post-close archival", () => {
      writeRunToDisk(artifactRoot, makeRun("run_disposed", {
        status: "completed",
        disposed_at: "2026-04-13T12:00:00.000Z",
      }));
      const store = makeStore(artifactRoot);

      const snapshot = store.captureRunSnapshotForWorkItem("studio-230");

      expect(snapshot).toEqual([
        expect.objectContaining({
          run_id: "run_disposed",
          status: "completed",
          disposed_at: "2026-04-13T12:00:00.000Z",
        }),
      ]);
    });
  });

  describe("emitRun / emitEvent / stream", () => {
    it("emitRun produces an envelope with the expected shape", async () => {
      const store = makeStore(artifactRoot);
      const events$ = store.stream().pipe(take(1), toArray());
      const events = firstValueFrom(events$);

      store.emitRun("execution_status", makeRun("run_env"));

      const [envelope] = await events;
      expect(envelope.type).toBe("execution_status");
      const payload = JSON.parse(envelope.data as string);
      expect(payload.event_id).toMatch(/^evt_\d+$/);
      expect(payload.stream_id).toBe("execution-runs");
      expect(payload.event_type).toBe("execution_status");
      expect(payload.session_id).toBe("run_env");
      expect(payload.payload.run.run_id).toBe("run_env");
    });

    it("emitEvent accepts a custom event_type and payload", async () => {
      const store = makeStore(artifactRoot);
      const events$ = store.stream().pipe(take(1), toArray());
      const events = firstValueFrom(events$);

      store.emitEvent("execution_checklist", "run_checklist", { items: [] });

      const [envelope] = await events;
      expect(envelope.type).toBe("execution_checklist");
      const payload = JSON.parse(envelope.data as string);
      expect(payload.event_type).toBe("execution_checklist");
      expect(payload.session_id).toBe("run_checklist");
      expect(payload.payload.items).toEqual([]);
    });

    it("stream delivers subsequent events to late subscribers but not past events", async () => {
      const store = makeStore(artifactRoot);
      // Fire an event before anyone subscribes — Subject has no replay.
      store.emitRun("execution_status", makeRun("run_before"));

      const events$ = store.stream().pipe(take(1), toArray());
      const events = firstValueFrom(events$);

      store.emitRun("execution_status", makeRun("run_after"));

      const [envelope] = await events;
      const payload = JSON.parse(envelope.data as string);
      expect(payload.session_id).toBe("run_after");
    });
  });

  describe("appendActivityLog", () => {
    it("appends to activity_log, stamps updated_at, writes status, but does NOT emit", () => {
      const run = makeRun("run_activity", {
        artifact_dir: join(artifactRoot, "runs", "run_activity"),
      });
      mkdirSync(run.artifact_dir, { recursive: true });
      const store = makeStore(artifactRoot, [run]);
      const writeSpy = vi.spyOn(store, "writeStatus");
      const emitSpy = vi.spyOn(store, "emitRun");

      const entry: ActivityLogEntry = {
        timestamp: "2026-04-13T12:00:00.000Z",
        kind: "user_message",
        message: "hello",
      };
      const updated = store.appendActivityLog("run_activity", entry);

      expect(updated?.activity_log.at(-1)).toEqual(entry);
      expect(updated?.updated_at).toBe("2026-04-13T12:00:00.000Z");
      expect(writeSpy).toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("returns null for unknown run ids", () => {
      const store = makeStore(artifactRoot);
      const result = store.appendActivityLog("run_missing", {
        timestamp: "2026-04-13T12:00:00.000Z",
        kind: "agent_message",
        message: "hi",
      });
      expect(result).toBeNull();
    });
  });
});
