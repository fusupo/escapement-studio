import { describe, expect, it, vi } from "vitest";
import type { WorkItemRecord } from "../../graph/types.js";
import type { SubAgentRunRecord } from "../../planning/types.js";
import { PlanPreparationError, PlanPreparationService } from "../plan-preparation.service.js";

function workItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-215",
    name: "Parallelize plan preparation",
    kind: "issue",
    state: "planned",
    repo: "fusupo/escapement-studio",
    issue_number: 215,
    issue_url: null,
    scope_hint: "Use bounded specialists",
    branch: null,
    archive_path: null,
    predicted_files: [" src/a.ts ", "src/b.ts", "src/a.ts", ""],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-12T00:00:00Z",
    ...overrides,
  };
}

function run(
  agentType: "code-crawler" | "scope-predictor",
  overrides: Partial<SubAgentRunRecord> = {},
): SubAgentRunRecord {
  const runId = `sub_${agentType}`;
  return {
    run_id: runId,
    agent_type: agentType,
    task: "task",
    status: "completed",
    created_at: "2026-04-12T00:00:00Z",
    updated_at: "2026-04-12T00:00:01Z",
    artifact_dir: `/tmp/${runId}`,
    result: {
      run_id: runId,
      agent_type: agentType,
      status: "completed",
      summary: `${agentType} summary`,
      confidence: "high",
      findings: [{ kind: "file_impact", file: "src/a.ts" }],
      open_questions: [],
      errors: [],
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("PlanPreparationService", () => {
  it("starts two explicitly bounded tasks and aggregates in declaration order", async () => {
    const crawler = deferred<SubAgentRunRecord>();
    const predictor = deferred<SubAgentRunRecord>();
    const runDelegation = vi.fn()
      .mockReturnValueOnce(crawler.promise)
      .mockReturnValueOnce(predictor.promise);
    const service = new PlanPreparationService({ runDelegation } as never);

    const completion = service.prepare(workItem());
    expect(runDelegation).toHaveBeenCalledTimes(2);
    expect(runDelegation.mock.calls.map(([input]) => input.agent_type)).toEqual([
      "code-crawler",
      "scope-predictor",
    ]);
    for (const [input] of runDelegation.mock.calls) {
      expect(input.repo).toBe("fusupo/escapement-studio");
      expect(input.work_item_ids).toEqual(["studio-215"]);
      expect(input.focus_paths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(input.task).toContain("studio-215");
      expect(input.notes).toContain("starting points");
    }

    predictor.resolve(run("scope-predictor"));
    crawler.resolve(run("code-crawler"));
    const result = await completion;

    expect(result.contributors.map((item) => item.task.agent_type)).toEqual([
      "code-crawler",
      "scope-predictor",
    ]);
    expect(result.degraded).toBe(false);
  });

  it("uses an explicit fallback when no focus paths are available", async () => {
    const runDelegation = vi.fn()
      .mockResolvedValueOnce(run("code-crawler"))
      .mockResolvedValueOnce(run("scope-predictor"));
    const service = new PlanPreparationService({ runDelegation } as never);

    await service.prepare(workItem({ predicted_files: [" ", ""] }));

    for (const [input] of runDelegation.mock.calls) {
      expect(input.focus_paths).toEqual([]);
      expect(input.notes).toContain("No predicted focus paths are available");
    }
  });

  it("retains a failed contributor as degraded when the other completes", async () => {
    const failed = run("code-crawler", {
      status: "error",
      result: {
        run_id: "sub_code-crawler",
        agent_type: "code-crawler",
        status: "error",
        summary: "crawler failed",
        confidence: "low",
        findings: [],
        errors: [{ code: "failed", message: "boom" }],
      },
    });
    const runDelegation = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(run("scope-predictor"));
    const service = new PlanPreparationService({ runDelegation } as never);

    const result = await service.prepare(workItem());

    expect(result.degraded).toBe(true);
    expect(result.contributors[0]).toMatchObject({
      run_id: "sub_code-crawler",
      status: "error",
      degraded: true,
      errors: [{ code: "failed", message: "boom" }],
    });
    expect(result.contributors[1].status).toBe("completed");
  });

  it("marks a completed low-confidence contributor as degraded", async () => {
    const lowConfidence = run("code-crawler");
    lowConfidence.result!.confidence = "low";
    const runDelegation = vi.fn()
      .mockResolvedValueOnce(lowConfidence)
      .mockResolvedValueOnce(run("scope-predictor"));
    const service = new PlanPreparationService({ runDelegation } as never);

    const result = await service.prepare(workItem());

    expect(result.degraded).toBe(true);
    expect(result.contributors[0]).toMatchObject({ status: "completed", degraded: true });
  });

  it("rejects when no specialist completes", async () => {
    const errorRun = (agentType: "code-crawler" | "scope-predictor") => run(agentType, {
      status: "error",
      result: undefined,
      progress_message: "failed",
    });
    const runDelegation = vi.fn()
      .mockResolvedValueOnce(errorRun("code-crawler"))
      .mockResolvedValueOnce(errorRun("scope-predictor"));
    const service = new PlanPreparationService({ runDelegation } as never);

    await expect(service.prepare(workItem())).rejects.toBeInstanceOf(PlanPreparationError);
  });
});
