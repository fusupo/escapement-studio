import { describe, expect, it } from "vitest";
import { classifyExecutionTerminalOutcome } from "../run-outcome.js";

describe("classifyExecutionTerminalOutcome", () => {
  it("classifies a summarized diff as completed success", () => {
    const outcome = classifyExecutionTerminalOutcome({
      phase: "initial",
      assistantText: "Implemented the requested change.",
      changedFiles: ["src/a.ts", "src/b.ts"],
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.terminalOutcome).toMatchObject({
      code: "success",
      severity: "success",
      changed_file_count: 2,
      summary_present: true,
    });
    expect(outcome.publishCompletedEvent).toBe(true);
    expect(outcome.dispatchRunError).toBe(false);
    expect(outcome.eventType).toBe("run_completed");
  });

  it("classifies a zero-diff run with a summary as a suspect no-op", () => {
    const outcome = classifyExecutionTerminalOutcome({
      phase: "initial",
      assistantText: "I inspected the tree but made no changes.",
      changedFiles: [],
    });

    expect(outcome.status).toBe("error");
    expect(outcome.terminalOutcome).toMatchObject({
      code: "no_changes",
      severity: "warn",
      changed_file_count: 0,
      summary_present: true,
    });
    expect(outcome.errors).toEqual([{ code: "no_changes", message: expect.stringMatching(/without changing files/) }]);
    expect(outcome.publishCompletedEvent).toBe(false);
    expect(outcome.dispatchRunError).toBe(true);
    expect(outcome.eventType).toBe("run_suspect");
  });

  it("classifies changed files without a summary as a missing-summary suspect", () => {
    const outcome = classifyExecutionTerminalOutcome({
      phase: "follow_up",
      assistantText: "   ",
      changedFiles: ["src/a.ts"],
    });

    expect(outcome.status).toBe("error");
    expect(outcome.terminalOutcome).toMatchObject({
      code: "missing_summary",
      severity: "warn",
      changed_file_count: 1,
      summary_present: false,
    });
    expect(outcome.resultSummary).toMatch(/No assistant summary was captured/);
    expect(outcome.eventType).toBe("follow_up_turn_suspect");
  });

  it("classifies the combined no-changes plus missing-summary case distinctly", () => {
    const outcome = classifyExecutionTerminalOutcome({
      phase: "follow_up",
      assistantText: null,
      changedFiles: [],
    });

    expect(outcome.terminalOutcome.code).toBe("no_changes_and_missing_summary");
    expect(outcome.terminalOutcome.detail).toMatch(/without changing files and without an assistant summary/);
  });
});
