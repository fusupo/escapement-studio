import { Inject, Injectable } from "@nestjs/common";
import { ExecutionService } from "../execution/execution.service.js";
import { GitHubBatchCache } from "../execution/github-batch-cache.service.js";
import { GitHubService } from "../github/github.service.js";
import type { UpdateWorkItemDto, WorkItemRecord, WorkItemState } from "./types.js";

export interface WorkItemHsmEvent {
  type:
    | "user.start_draft"
    | "draft.completed"
    | "draft.failed"
    | "user.dispatch"
    | "run.completed"
    | "run.failed"
    | "gh.pr_merged"
    | "gh.pr_closed"
    | "gh.pr_reopened"
    | "user.finalize"
    | "user.archive_and_finalize"
    | "user.defer"
    | "user.undefer"
    | "user.cancel"
    | "user.retry";
  payload?: Record<string, unknown>;
}

export interface HsmActionContext {
  workItem: WorkItemRecord;
  event: WorkItemHsmEvent;
  now: () => string;
}

export interface HsmActionResult {
  patch?: UpdateWorkItemDto;
  output?: Record<string, unknown>;
}

export interface PlanDraftInvokeHandle {
  sessionId?: string | null;
  completion: Promise<void>;
  cancel: () => void;
}

@Injectable()
export class HsmActionHandlers {
  constructor(
    @Inject(ExecutionService) private readonly executionService: ExecutionService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
    @Inject(GitHubBatchCache) private readonly githubBatchCache: GitHubBatchCache,
  ) {}

  async createRunRecord(ctx: HsmActionContext): Promise<HsmActionResult> {
    const run = this.executionService.createHsmRunRecord(ctx.workItem);
    return {
      patch: {
        meta: this.mergeMeta(ctx.workItem.meta, {
          studio_dispatch_run: {
            at: ctx.now(),
            run_id: run.run_id,
            branch: run.branch,
            base_ref: run.base_ref,
          },
        }),
      },
      output: { run_id: run.run_id },
    };
  }

  stampMeta(blockName: string) {
    return async (ctx: HsmActionContext): Promise<HsmActionResult> => ({
      patch: {
        meta: this.mergeMeta(ctx.workItem.meta, {
          [blockName]: {
            at: ctx.now(),
            ...(ctx.event.payload ?? {}),
          },
        }),
      },
    });
  }

  async closeGhIssue(ctx: HsmActionContext): Promise<HsmActionResult> {
    if (ctx.workItem.kind !== "issue" || !ctx.workItem.repo || !ctx.workItem.issue_number) {
      return {};
    }

    const current = await this.githubService.readIssue(ctx.workItem.repo, ctx.workItem.issue_number);
    const details = current.state.toLowerCase() === "closed"
      ? current
      : await this.githubService.closeIssue(ctx.workItem.repo, ctx.workItem.issue_number);

    this.githubBatchCache.upsertIssue(ctx.workItem.repo, {
      number: details.number,
      state: "closed",
      closed_at: null,
      url: details.url,
      title: details.title,
    });

    return {
      patch: {
        meta: this.mergeMeta(ctx.workItem.meta, {
          studio_issue_close_sync: {
            at: ctx.now(),
            issue: {
              number: details.number,
              url: details.url,
              title: details.title,
              state: "closed",
            },
          },
        }),
      },
    };
  }

  async runArchiver(ctx: HsmActionContext): Promise<HsmActionResult> {
    const result = this.executionService.archiveRunArtifacts(ctx.workItem.id);
    return {
      patch: {
        archive_path: result.archive_path,
        meta: this.mergeMeta(ctx.workItem.meta, {
          studio_archive_sync: {
            at: ctx.now(),
            archive_path: result.archive_path,
            archived_run_ids: result.archived_run_ids,
          },
        }),
      },
    };
  }

  kickOffPlanDrafter(_ctx: HsmActionContext): PlanDraftInvokeHandle {
    return {
      sessionId: null,
      completion: Promise.resolve(),
      cancel: () => {},
    };
  }

  private mergeMeta(
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      const prior = next[key];
      if (this.isPlainObject(prior) && this.isPlainObject(value)) {
        next[key] = this.mergeMeta(prior as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        next[key] = value;
      }
    }
    return next;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}

export interface ResolvedTransition {
  target: WorkItemState;
  exitActions?: Array<(ctx: HsmActionContext) => Promise<HsmActionResult> | HsmActionResult>;
  transitionActions?: Array<(ctx: HsmActionContext) => Promise<HsmActionResult> | HsmActionResult>;
  entryActions?: Array<(ctx: HsmActionContext) => Promise<HsmActionResult> | HsmActionResult>;
  startInvoke?: boolean;
  preserveHistory?: WorkItemState | null;
}
