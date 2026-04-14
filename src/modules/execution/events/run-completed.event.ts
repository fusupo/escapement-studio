import type { IEvent } from "@nestjs/cqrs";
import type { ExecutionPullRequestRecord } from "../types.js";

/**
 * Phase 5 (#225): fires after `ExecutionService.executeRun` writes
 * its final `status: "completed"` update and emits the
 * `execution_result` SSE envelope. Represents "a coding run just
 * finished successfully" as a fact that future consumers can react
 * to (e.g. auto-staging managed block syncs, the Phase 8 drift
 * report, notifications).
 *
 * No subscribers land in Phase 5. `pullRequest` is optional because
 * PR creation is a separate step that happens after the run
 * completes — most freshly-completed runs do NOT have a PR yet.
 */
export class RunCompletedEvent implements IEvent {
  constructor(
    public readonly runId: string,
    public readonly workItemId: string,
    public readonly changedFiles: string[],
    public readonly resultSummary: string,
    public readonly pullRequest: ExecutionPullRequestRecord | null,
  ) {}
}
