import type { ExecutionRunRecord, ExecutionRunStatus, ExecutionTerminalOutcome } from "./types.js";

export interface ClassifyExecutionTerminalOutcomeInput {
  phase: "initial" | "follow_up";
  assistantText?: string | null;
  changedFiles: string[];
}

export interface ClassifiedExecutionTerminalOutcome {
  status: Extract<ExecutionRunStatus, "completed" | "error">;
  terminalOutcome: ExecutionTerminalOutcome;
  progressMessage: string;
  resultSummary: string;
  activityMessage: string;
  errors: NonNullable<ExecutionRunRecord["errors"]>;
  eventType: "run_completed" | "run_suspect" | "follow_up_turn_completed" | "follow_up_turn_suspect";
  publishCompletedEvent: boolean;
  dispatchRunError: boolean;
}

export function classifyExecutionTerminalOutcome(
  input: ClassifyExecutionTerminalOutcomeInput,
): ClassifiedExecutionTerminalOutcome {
  const changedFiles = [...new Set(input.changedFiles.filter((value) => typeof value === "string" && value.trim().length > 0))];
  const summary = input.assistantText?.trim() ?? "";
  const summaryPresent = summary.length > 0;
  const changedFileCount = changedFiles.length;
  const phaseLabel = input.phase === "follow_up" ? "Follow-up turn" : "Execution run";
  const successMessage = input.phase === "follow_up"
    ? `Follow-up turn completed. ${changedFileCount} file(s) changed.`
    : `Execution completed. ${changedFileCount} file(s) changed.`;

  if (changedFileCount > 0 && summaryPresent) {
    return {
      status: "completed",
      terminalOutcome: {
        code: "success",
        severity: "success",
        label: "completed",
        detail: `${phaseLabel} completed with ${changedFileCount} changed file(s) and an assistant summary.`,
        changed_file_count: changedFileCount,
        summary_present: true,
      },
      progressMessage: input.phase === "follow_up" ? "Follow-up turn completed." : "Execution run completed.",
      resultSummary: summary,
      activityMessage: successMessage,
      errors: [],
      eventType: input.phase === "follow_up" ? "follow_up_turn_completed" : "run_completed",
      publishCompletedEvent: true,
      dispatchRunError: false,
    };
  }

  const code = changedFileCount === 0 && !summaryPresent
    ? "no_changes_and_missing_summary"
    : changedFileCount === 0
      ? "no_changes"
      : "missing_summary";

  const detail = code === "no_changes_and_missing_summary"
    ? `${phaseLabel} ended without changing files and without an assistant summary.`
    : code === "no_changes"
      ? `${phaseLabel} ended without changing files.`
      : `${phaseLabel} changed files but did not produce an assistant summary.`;
  const resultSummary = [
    `${phaseLabel} requires review: ${detail}`,
    summaryPresent ? `Assistant output:\n${summary}` : "No assistant summary was captured.",
  ].join("\n\n");

  return {
    status: "error",
    terminalOutcome: {
      code,
      severity: "warn",
      label: code === "missing_summary" ? "summary missing" : "no-op suspect",
      detail,
      changed_file_count: changedFileCount,
      summary_present: summaryPresent,
    },
    progressMessage: `${phaseLabel} requires review.`,
    resultSummary,
    activityMessage: `${phaseLabel} requires review. ${changedFileCount} file(s) changed.${summaryPresent ? " Assistant summary captured." : " No assistant summary captured."}`,
    errors: [{ code, message: detail }],
    eventType: input.phase === "follow_up" ? "follow_up_turn_suspect" : "run_suspect",
    publishCompletedEvent: false,
    dispatchRunError: true,
  };
}
