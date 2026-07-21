import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import * as executionSync from "../../../../web/src/lib/execution-sync.js";

const { createExecutionSyncCoordinator } = executionSync;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("execution synchronization coordinator", () => {
  it("runs the first requested synchronization and records its success time", async () => {
    const completedAt = new Date("2026-07-21T12:34:56.000Z");
    const states: Array<{ status: string; lastSuccessfulSyncAt: Date | null }> = [];
    const reload = vi.fn().mockResolvedValue(undefined);
    const coordinator = createExecutionSyncCoordinator({
      reload,
      now: () => completedAt,
      onStateChange: (state: { status: string; lastSuccessfulSyncAt: Date | null }) => states.push(state),
    });

    await coordinator.requestSync();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.status)).toEqual(["syncing", "fresh"]);
    expect(coordinator.getState()).toEqual({
      status: "fresh",
      lastSuccessfulSyncAt: completedAt,
      error: null,
    });
  });

  it("serializes reloads and coalesces concurrent triggers into one queued rerun", async () => {
    const first = deferred();
    const second = deferred();
    let activeReloads = 0;
    let maximumActiveReloads = 0;
    const reload = vi.fn()
      .mockImplementationOnce(async () => {
        activeReloads += 1;
        maximumActiveReloads = Math.max(maximumActiveReloads, activeReloads);
        await first.promise;
        activeReloads -= 1;
      })
      .mockImplementationOnce(async () => {
        activeReloads += 1;
        maximumActiveReloads = Math.max(maximumActiveReloads, activeReloads);
        await second.promise;
        activeReloads -= 1;
      });
    const coordinator = createExecutionSyncCoordinator({ reload });

    const synchronization = coordinator.requestSync();
    await nextTurn();
    coordinator.requestSync();
    coordinator.requestSync();
    expect(reload).toHaveBeenCalledTimes(1);

    first.resolve();
    await nextTurn();
    expect(reload).toHaveBeenCalledTimes(2);

    second.resolve();
    await synchronization;
    expect(reload).toHaveBeenCalledTimes(2);
    expect(maximumActiveReloads).toBe(1);
  });

  it("retains the last success time on failure and can recover", async () => {
    const firstSuccess = new Date("2026-07-21T10:00:00.000Z");
    const recoveredAt = new Date("2026-07-21T10:05:00.000Z");
    const failure = new Error("preview unavailable");
    const times = [firstSuccess, recoveredAt];
    const reload = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const coordinator = createExecutionSyncCoordinator({ reload, now: () => times.shift() });

    await coordinator.requestSync();
    await coordinator.requestSync();
    expect(coordinator.getState()).toEqual({
      status: "stale",
      lastSuccessfulSyncAt: firstSuccess,
      error: failure,
    });

    await coordinator.requestSync();
    expect(coordinator.getState()).toEqual({
      status: "fresh",
      lastSuccessfulSyncAt: recoveredAt,
      error: null,
    });
  });

  it("suppresses queued work and notifications after disposal", async () => {
    const inFlight = deferred();
    const onStateChange = vi.fn();
    const reload = vi.fn(() => inFlight.promise);
    const coordinator = createExecutionSyncCoordinator({ reload, onStateChange });

    const synchronization = coordinator.requestSync();
    await nextTurn();
    coordinator.requestSync();
    coordinator.dispose();
    inFlight.resolve();
    await synchronization;

    expect(reload).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    await coordinator.requestSync();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recovers a missed refinement transition from the persisted run snapshot", async () => {
    let runs: Array<Record<string, unknown>> = [
      { run_id: "exec_277", status: "running", phase: "refining_plan", refinement: null },
    ];
    const persistedRuns = [{
      run_id: "exec_277",
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        items: [
          { id: "question-1", kind: "question", prompt: "Which deployment target?", response: null },
          { id: "blocker-1", kind: "blocker", prompt: "Confirm file ownership", response: null },
        ],
      },
    }];
    const coordinator = createExecutionSyncCoordinator({
      reload: async () => { runs = persistedRuns; },
      now: () => new Date("2026-07-21T11:00:00.000Z"),
    });

    expect(runs[0]).toMatchObject({ status: "running", phase: "refining_plan" });
    await coordinator.requestSync();

    expect(runs[0]).toMatchObject({
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: { items: [{ kind: "question" }, { kind: "blocker" }] },
    });
    expect(coordinator.getState().status).toBe("fresh");
  });
});
