import { BadRequestException, Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { GitHubService } from "../github/github.service.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { RunDispositionService } from "./run-disposition.service.js";
import type {
  HsmActionHandlerContext,
  WorkItemHsmEvent,
  WorkItemRecord,
} from "../graph/types.js";

/**
 * Phase 1 of the cqrs refactor (#221): the live HSM action path used to
 * be two inline closures inside `ExecutionService.onModuleInit`. They are
 * lifted here so the live path is named, importable, and testable
 * independently of the rest of `ExecutionService`.
 *
 * Registers two action handlers against `WorkItemHsmService` on
 * application bootstrap:
 *
 *   - `closeGhIssue`  — runs on `user.finalize` / `user.archive_and_finalize`
 *                        from the `merged_pr` and `closed` states. Closes the
 *                        backing GitHub issue and surfaces the closed-issue
 *                        details on the dispatch result envelope.
 *   - `runArchiver`   — runs on `user.archive_and_finalize`. Snapshots the
 *                        work item's runs, moves the plan dir into archives,
 *                        writes the README, and stamps `studio_archive` meta.
 *
 * Both methods conform to the runtime `HsmActionHandler` signature in
 * `src/modules/graph/types.ts` — they receive `(workItem, event, ctx)`,
 * mutate `ctx.handler_data` / `ctx.meta` / `ctx.patch_overrides` in place,
 * and return `Promise<void>`.
 *
 * The temporary public hooks on `ExecutionService` (`getArtifactRoot`,
 * `logWarn`, `captureRunSnapshotForWorkItem`, `movePlanDirToArchives`)
 * are TODO(phase-3) seams — Phase 3 moves disposition into a dedicated
 * `RunDispositionService` and these hooks disappear.
 */
@Injectable()
export class HsmActionHandlers implements OnModuleInit {
  constructor(
    @Inject(WorkItemHsmService) private readonly hsm: WorkItemHsmService,
    @Inject(GitHubService) private readonly github: GitHubService,
    @Inject(RunDispositionService) private readonly disposition: RunDispositionService,
  ) {}

  onModuleInit(): void {
    this.hsm.registerActionHandler(
      "closeGhIssue",
      (workItem, event, ctx) => this.closeGhIssue(workItem, event, ctx),
    );
    this.hsm.registerActionHandler(
      "runArchiver",
      (workItem, event, ctx) => this.runArchiver(workItem, event, ctx),
    );
  }

  async closeGhIssue(
    workItem: WorkItemRecord,
    _event: WorkItemHsmEvent,
    ctx: HsmActionHandlerContext,
  ): Promise<void> {
    if (workItem.kind !== "issue" || !workItem.repo || !workItem.issue_number) {
      return;
    }
    try {
      const details = await this.github.closeIssue(
        workItem.repo,
        workItem.issue_number,
      );
      ctx.handler_data.closed_issue = {
        repo: details.repo,
        number: details.number,
        url: details.url,
        title: details.title,
        state: details.state,
      };
    } catch (error) {
      throw new BadRequestException(
        `close_merged_failed_github_close: ${this.getErrorMessage(error)}`,
      );
    }
  }

  async runArchiver(
    workItem: WorkItemRecord,
    event: WorkItemHsmEvent,
    ctx: HsmActionHandlerContext,
  ): Promise<void> {
    await this.disposition.archiveRunArtifactsAction(workItem, event, ctx);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
