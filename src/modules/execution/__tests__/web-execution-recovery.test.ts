import { describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally plain JavaScript.
import * as executionRecovery from "../../../../web/src/lib/execution-recovery.js";

const { projectExecutionRecovery } = executionRecovery;

const errorRun = { run_id: "exec_271", work_item_id: "studio-271", status: "error" };
const eligible = {
  issue_backed: true,
  can_launch: true,
  launch_unavailable_reason: null,
  safety_checks: [{ code: "frontier", status: "pass", message: "Dispatchable." }],
};

function project(overrides: Record<string, unknown> = {}) {
  return projectExecutionRecovery({
    run: errorRun,
    workItem: { id: "studio-271", state: "pre_pr.ready" },
    eligibility: eligible,
    ...overrides,
  });
}

describe("execution recovery projection", () => {
  it("is inactive for a non-error run", () => {
    expect(project({ run: { ...errorRun, status: "completed" } })).toMatchObject({
      active: false,
      canRedispatch: false,
      graphState: null,
    });
  });

  it("allows a ready, issue-backed, eligible item to be re-dispatched", () => {
    expect(project()).toMatchObject({
      active: true,
      graphState: "pre_pr.ready",
      canRedispatch: true,
      canInvestigate: false,
      safetyChecks: eligible.safety_checks,
    });
  });

  it("blocks a ready item that is not issue-backed", () => {
    const result = project({
      eligibility: {
        ...eligible,
        issue_backed: false,
        can_launch: false,
        launch_unavailable_reason: "Only issue-backed work items can launch.",
      },
    });

    expect(result.canRedispatch).toBe(false);
    expect(result.reason).toBe("Only issue-backed work items can launch.");
  });

  it("surfaces eligibility safety failures", () => {
    const safetyChecks = [{ code: "dependency", status: "fail", message: "Dependency is incomplete." }];
    const result = project({
      eligibility: {
        ...eligible,
        can_launch: false,
        launch_unavailable_reason: "Dependency is incomplete.",
        safety_checks: safetyChecks,
      },
    });

    expect(result).toMatchObject({ canRedispatch: false, reason: "Dependency is incomplete.", safetyChecks });
  });

  it("does not use a stale investigate event after an item reaches ready", () => {
    const result = project({
      eligibility: { ...eligible, can_launch: false, launch_unavailable_reason: "Dependency is incomplete." },
      reconciled: { enabled_events: ["user.investigate"] },
    });

    expect(result).toMatchObject({ canRedispatch: false, canInvestigate: false });
  });

  it("offers chained Re-dispatch for run_errored with investigate enabled", () => {
    const result = project({
      workItem: { id: "studio-271", state: "pre_pr.run_errored" },
      eligibility: { ...eligible, can_launch: false, launch_unavailable_reason: null },
      reconciled: {
        enabled_events: ["user.investigate"],
        rationale: "Investigate the failed run before relaunching.",
      },
    });

    expect(result).toMatchObject({ canRedispatch: true, canInvestigate: true });
    expect(result.reason).toBe("Investigate the failed run before relaunching.");
  });

  it("offers chained Re-dispatch for in_progress only when investigate is explicitly enabled", () => {
    const result = project({
      workItem: { id: "studio-271", state: "pre_pr.in_progress" },
      eligibility: { ...eligible, can_launch: false, launch_unavailable_reason: null },
      reconciled: { enabled_events: ["user.investigate"] },
    });

    expect(result).toMatchObject({ canRedispatch: true, canInvestigate: true });
  });

  it("does not infer investigation when reconciliation is missing", () => {
    const result = project({
      workItem: { id: "studio-271", state: "pre_pr.run_errored" },
      eligibility: { ...eligible, can_launch: false, launch_unavailable_reason: null },
      reconciled: null,
    });

    expect(result).toMatchObject({ canRedispatch: false, canInvestigate: false });
    expect(result.reason).toContain("pre_pr.run_errored");
  });

  it("surfaces lookup failures and disables recovery", () => {
    const result = project({ workItem: null, eligibility: null, lookupError: new Error("Lookup failed") });

    expect(result).toMatchObject({
      graphState: "unknown",
      canRedispatch: false,
      error: "Lookup failed",
      reason: "Lookup failed",
    });
  });

  it("disables recovery while loading or while an action is in flight", () => {
    expect(project({ loading: true })).toMatchObject({ canRedispatch: false, loading: true });
    expect(project({ actionInFlight: true })).toMatchObject({ canRedispatch: false, actionInFlight: true });
  });
});
