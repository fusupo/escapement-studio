import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExecutionService } from "../execution.service.js";
import { RunInteractionService } from "../run-interaction.service.js";
import { RunStore } from "../run-store.service.js";
import { ScratchpadService } from "../scratchpad.service.js";
import type { ExecutionRunRecord, ExecutionRunStatus } from "../types.js";
import { canonicalScratchpadPath } from "../../../lib/context-layout.js";

/**
 * Phase 4a (#230): the run buffer + disk primitives moved from
 * `ExecutionService` into `RunStore`. Tests that used to construct an
 * `ExecutionService.prototype` harness for buffer / hydrate / pushActivity
 * / chat-history / rehydrate-run-detail assertions now build a `RunStore`
 * harness for the low-level cases and compose an `ExecutionService` harness
 * with a `runStore` field for the read-side APIs
 * (`getRunChatHistory` / `getRunScratchpad` / `getRunChecklist`) that still
 * live on `ExecutionService` but delegate to `RunStore`.
 */

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

function makeRunStoreWithEmptyBuffer(artifactRoot: string): RunStore {
  const store = Object.create(RunStore.prototype) as RunStore;
  (store as any).logger = { log: vi.fn(), warn: vi.fn() };
  (store as any).artifactRoot = artifactRoot;
  (store as any).recentRuns = [];
  (store as any).recentRunLimit = 16;
  (store as any).eventSubject = { next: vi.fn() };
  (store as any).eventCounter = 0;
  (store as any).streamId = "execution-runs";
  return store;
}

function makeExecutionServiceHarness(
  artifactRoot: string,
  runStore: RunStore,
  extras: Record<string, unknown> = {},
): ExecutionService {
  const service = Object.create(ExecutionService.prototype) as ExecutionService;
  (service as any).logger = { log: vi.fn(), warn: vi.fn() };
  (service as any).artifactRoot = artifactRoot;
  (service as any).runStore = runStore;
  (service as any).now = () => "2026-04-10T06:00:00.000Z";
  // Phase 4c (#232): the thin-wrapper HTTP getters
  // (`getRunScratchpad` / `getRunChecklist`) delegate to a real
  // ScratchpadService instance. Construct a bare-prototype
  // ScratchpadService with the same artifactRoot so the rehydrate
  // tests can exercise the canonical + worktree read paths.
  const scratchpad = Object.create(ScratchpadService.prototype) as ScratchpadService;
  (scratchpad as any).artifactRoot = artifactRoot;
  (scratchpad as any).logger = { warn: vi.fn() };
  (scratchpad as any).runStore = runStore;
  (service as any).scratchpadService = scratchpad;
  // Phase 4d (#233): the session lifecycle + pushActivity + getRunChatHistory
  // + handleSessionEvent + sendFollowUp all live on RunInteractionService.
  // Construct a bare-prototype instance sharing the same runStore +
  // scratchpadService so the rehydrate tests exercise the real
  // activity-log / chat-history / event-translation logic without
  // booting Nest DI. The `now` + `extractTextFromMessage` overrides
  // match the pre-4d harness so existing test assertions keep their
  // deterministic timestamps and their simplified message shape.
  const interaction = Object.create(RunInteractionService.prototype) as RunInteractionService;
  (interaction as any).logger = { log: vi.fn(), warn: vi.fn() };
  (interaction as any).runStore = runStore;
  (interaction as any).scratchpadService = scratchpad;
  (interaction as any).activeSessions = new Map();
  (interaction as any).disambiguationGates = new Map();
  (interaction as any).now = () => "2026-04-10T06:00:00.000Z";
  (interaction as any).extractTextFromMessage = (message: any) => message?.text ?? null;
  (service as any).runInteractionService = interaction;
  Object.assign(service as any, extras);
  return service;
}

describe("RunStore.hydrateRecentRunsFromDisk", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "exec-rehydrate-"));
    mkdirSync(join(artifactRoot, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("loads completed runs from disk into recentRuns sorted newest-first", () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_a", { updated_at: "2026-04-01T00:00:00.000Z" }));
    writeRun(runsDir, makeRun("run_b", { updated_at: "2026-04-03T00:00:00.000Z" }));
    writeRun(runsDir, makeRun("run_c", { updated_at: "2026-04-02T00:00:00.000Z" }));

    const store = makeRunStoreWithEmptyBuffer(artifactRoot);
    store.hydrateRecentRunsFromDisk();

    expect((store as any).recentRuns.map((r: ExecutionRunRecord) => r.run_id)).toEqual([
      "run_b",
      "run_c",
      "run_a",
    ]);
  });

  it("dedupes by run_id when the in-memory buffer already has an entry", () => {
    const runsDir = join(artifactRoot, "runs");
    writeRun(runsDir, makeRun("run_a"));

    const store = makeRunStoreWithEmptyBuffer(artifactRoot);
    (store as any).recentRuns.push(makeRun("run_a", { progress_message: "already-tracked" }));
    store.hydrateRecentRunsFromDisk();

    const runs = (store as any).recentRuns as ExecutionRunRecord[];
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

    const store = makeRunStoreWithEmptyBuffer(artifactRoot);
    store.hydrateRecentRunsFromDisk();

    const runs = (store as any).recentRuns as ExecutionRunRecord[];
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

    const store = makeRunStoreWithEmptyBuffer(artifactRoot);
    store.hydrateRecentRunsFromDisk();

    const runs = (store as any).recentRuns as ExecutionRunRecord[];
    expect(runs.map((run) => run.run_id)).toEqual(["run_completed", "run_error"]);
    expect(runs[0].result_summary).toBe("done");
    expect(runs[0].changed_files).toEqual(["src/a.ts"]);
    expect(runs[0].pull_request?.number).toBe(130);
    expect(runs[1].errors).toEqual([{ code: "boom", message: "boom" }]);
  });

  it("is a no-op when the runs dir does not exist", () => {
    rmSync(join(artifactRoot, "runs"), { recursive: true, force: true });
    const store = makeRunStoreWithEmptyBuffer(artifactRoot);
    store.hydrateRecentRunsFromDisk();
    expect((store as any).recentRuns).toEqual([]);
  });
});

describe("ExecutionService activity persistence", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "exec-activity-"));
    mkdirSync(join(artifactRoot, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  function makeService(run: ExecutionRunRecord): { service: ExecutionService; runStore: RunStore } {
    const runStore = makeRunStoreWithEmptyBuffer(artifactRoot);
    (runStore as any).recentRuns.push(run);
    const service = makeExecutionServiceHarness(artifactRoot, runStore);
    return { service, runStore };
  }

  it("flushes pushActivity updates to status.json so chat survives a restart", () => {
    const runsDir = join(artifactRoot, "runs");
    const run = makeRun("run_chat", {
      status: "running",
      artifact_dir: join(runsDir, "run_chat"),
    });
    writeRun(runsDir, run);

    const { service } = makeService(run);
    (service as any).runInteractionService.pushActivity("run_chat", "user_message", "Please keep the summary short.");

    const persisted = JSON.parse(readFileSync(join(runsDir, "run_chat", "status.json"), "utf8")) as ExecutionRunRecord;
    expect(persisted.updated_at).toBe("2026-04-10T06:00:00.000Z");
    expect(persisted.activity_log.at(-1)).toMatchObject({
      kind: "user_message",
      message: "Please keep the summary short.",
    });

    // Simulated restart: fresh RunStore + fresh ExecutionService harness.
    const restartedStore = makeRunStoreWithEmptyBuffer(artifactRoot);
    restartedStore.hydrateRecentRunsFromDisk();
    const restarted = makeExecutionServiceHarness(artifactRoot, restartedStore);
    expect(restarted.getRunChatHistory("run_chat").messages).toEqual([
      {
        timestamp: "2026-04-10T06:00:00.000Z",
        role: "user",
        text: "Please keep the summary short.",
      },
    ]);
  });

  it("persists assistant message_end events into the durable activity log", () => {
    const runsDir = join(artifactRoot, "runs");
    const run = makeRun("run_agent", {
      status: "running",
      artifact_dir: join(runsDir, "run_agent"),
    });
    writeRun(runsDir, run);

    const { service } = makeService(run);
    (service as any).runInteractionService.handleSessionEvent("run_agent", {
      type: "message_end",
      message: { text: "Implemented the restart recovery flow." } as any,
    } as any);

    const persisted = JSON.parse(readFileSync(join(runsDir, "run_agent", "status.json"), "utf8")) as ExecutionRunRecord;
    expect(persisted.activity_log.at(-1)).toMatchObject({
      kind: "agent_message",
      message: "Implemented the restart recovery flow.",
    });

    const restartedStore = makeRunStoreWithEmptyBuffer(artifactRoot);
    restartedStore.hydrateRecentRunsFromDisk();
    const restarted = makeExecutionServiceHarness(artifactRoot, restartedStore);
    expect(restarted.getRunChatHistory("run_agent").messages).toEqual([
      {
        timestamp: "2026-04-10T06:00:00.000Z",
        role: "assistant",
        text: "Implemented the restart recovery flow.",
      },
    ]);
  });

  it("persists follow-up user messages even when the run cannot accept them", async () => {
    const runsDir = join(artifactRoot, "runs");
    const run = makeRun("run_follow_up", {
      status: "error",
      artifact_dir: join(runsDir, "run_follow_up"),
    });
    writeRun(runsDir, run);

    const { service } = makeService(run);
    const result = await service.sendFollowUp({
      run_id: "run_follow_up",
      message: "Can you explain what failed?",
    });

    expect(result.accepted).toBe(false);
    const persisted = JSON.parse(readFileSync(join(runsDir, "run_follow_up", "status.json"), "utf8")) as ExecutionRunRecord;
    expect(persisted.activity_log.at(-1)).toMatchObject({
      kind: "user_message",
      message: "Can you explain what failed?",
    });
  });
});

describe("ExecutionService run detail rehydration", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "exec-detail-"));
    mkdirSync(join(artifactRoot, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("rehydrates recent run details from status.json, canonical scratchpads, and surviving worktrees", () => {
    const runsDir = join(artifactRoot, "runs");
    const worktreePath = join(artifactRoot, "worktrees", "studio-176-branch");
    mkdirSync(worktreePath, { recursive: true });

    const run = makeRun("run_detail", {
      status: "completed",
      updated_at: "2026-04-10T07:00:00.000Z",
      worktree_path: worktreePath,
      artifact_dir: join(runsDir, "run_detail"),
      activity_log: [
        { timestamp: "2026-04-10T06:00:00.000Z", kind: "user_message", message: "Please persist this run." },
        { timestamp: "2026-04-10T06:05:00.000Z", kind: "agent_message", message: "Persistence is now durable." },
      ],
    });
    writeRun(runsDir, run);

    const canonicalPath = canonicalScratchpadPath(artifactRoot, run.work_item_id);
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(canonicalPath, "canonical scratchpad content", "utf8");
    writeFileSync(join(worktreePath, "SCRATCHPAD_studio_176.md"), [
      "# Scratchpad",
      "",
      "## Implementation Plan",
      "- [x] Persist run state",
      "- [ ] Rehydrate detail endpoints",
    ].join("\n"), "utf8");

    const runStore = makeRunStoreWithEmptyBuffer(artifactRoot);
    runStore.hydrateRecentRunsFromDisk();
    const service = makeExecutionServiceHarness(artifactRoot, runStore);

    expect(runStore.listRecentRuns().map((candidate) => candidate.run_id)).toEqual(["run_detail"]);
    expect(service.getRunChatHistory("run_detail").messages).toEqual([
      {
        timestamp: "2026-04-10T06:00:00.000Z",
        role: "user",
        text: "Please persist this run.",
      },
      {
        timestamp: "2026-04-10T06:05:00.000Z",
        role: "assistant",
        text: "Persistence is now durable.",
      },
    ]);
    expect(service.getRunScratchpad("run_detail")).toEqual({
      run_id: "run_detail",
      content: "canonical scratchpad content",
    });
    expect(service.getRunChecklist("run_detail")).toEqual({
      run_id: "run_detail",
      revision: 1,
      updated_at: expect.any(String),
      items: [
        { text: "Persist run state", checked: true, category: "implementation" },
        { text: "Rehydrate detail endpoints", checked: false, category: "implementation" },
      ],
      completed: 1,
      total: 2,
    });
    const persisted = JSON.parse(readFileSync(join(runsDir, "run_detail", "status.json"), "utf8"));
    expect(persisted.checklist.revision).toBe(1);
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

    const runStore = makeRunStoreWithEmptyBuffer(artifactRoot);
    const service = makeExecutionServiceHarness(artifactRoot, runStore, {
      workItemReconciler: reconcilerStub,
      hsmService: { registerActionHandler: vi.fn() },
    });

    await service.onModuleInit();

    expect(reconcilerStub.runStartupReconcile).toHaveBeenCalledTimes(1);
    const runs = (runStore as any).recentRuns as ExecutionRunRecord[];
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

    const runStore = makeRunStoreWithEmptyBuffer(artifactRoot);
    const logger = { log: vi.fn(), warn: vi.fn() };
    const service = makeExecutionServiceHarness(artifactRoot, runStore, {
      logger,
      workItemReconciler: {
        runStartupReconcile: vi.fn(async () => {
          throw new Error("reconciler boom");
        }),
      },
      hsmService: { registerActionHandler: vi.fn() },
    });

    await service.onModuleInit();

    expect(logger.warn).toHaveBeenCalled();
    expect((runStore as any).recentRuns).toHaveLength(1);
  });
});
