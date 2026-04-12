import { Inject, Injectable } from "@nestjs/common";
import { HsmActionHandlers, type HsmActionContext, type HsmActionResult, type PlanDraftInvokeHandle, type ResolvedTransition, type WorkItemHsmEvent } from "./hsm-action-handlers.js";
import { HsmGuardHandlers } from "./hsm-guard-handlers.js";
import type { UpdateWorkItemDto, WorkItemRecord, WorkItemState } from "./types.js";
import { WorkItemsService } from "./work-items.service.js";

export interface WorkItemHsmDispatchResult {
  accepted: boolean;
  workItem: WorkItemRecord;
  previousState: WorkItemState;
  nextState: WorkItemState;
  enabled_events: WorkItemHsmEvent["type"][];
  output: Record<string, unknown>;
}

@Injectable()
export class WorkItemHsmService {
  private readonly activeDraftInvokes = new Map<string, { token: symbol; handle: PlanDraftInvokeHandle }>();

  constructor(
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(HsmActionHandlers) private readonly actions: HsmActionHandlers,
    @Inject(HsmGuardHandlers) private readonly guards: HsmGuardHandlers,
  ) {}

  async dispatch(workItemId: string, event: WorkItemHsmEvent): Promise<WorkItemHsmDispatchResult> {
    const workItem = this.workItemsService.get(workItemId);
    const transition = await this.resolveTransition(workItem, event);
    if (!transition) {
      throw new Error(`WorkItemHsmService.dispatch: event ${event.type} is not accepted from ${workItem.state}`);
    }

    const isLeavingDrafting = workItem.state === "drafting" && transition.target !== "drafting";
    if (isLeavingDrafting) {
      this.cancelDraftInvoke(workItem.id);
    }

    const output: Record<string, unknown> = {};
    let patch: UpdateWorkItemDto = {};

    if (transition.preserveHistory) {
      patch.meta = this.mergeMeta(workItem.meta, {
        hsm_history: { pre_pr: transition.preserveHistory },
      });
    }

    const baseCtx: HsmActionContext = {
      workItem,
      event,
      now: () => new Date().toISOString(),
    };

    patch = this.mergePatch(patch, await this.runActions(transition.exitActions, baseCtx, output));
    patch = this.mergePatch(patch, await this.runActions(transition.transitionActions, baseCtx, output));

    const transitioned = this.workItemsService.update(workItem.id, {
      ...patch,
      state: transition.target,
    });

    const entryCtx: HsmActionContext = {
      workItem: transitioned,
      event,
      now: baseCtx.now,
    };
    const entryPatch = await this.runActions(transition.entryActions, entryCtx, output);
    const afterEntry = Object.keys(entryPatch).length > 0
      ? this.workItemsService.update(workItem.id, this.mergePatch({}, entryPatch))
      : transitioned;

    if (transition.startInvoke) {
      this.startDraftInvoke(afterEntry, event);
    }

    return {
      accepted: true,
      workItem: this.workItemsService.get(workItem.id),
      previousState: workItem.state,
      nextState: transition.target,
      enabled_events: await this.getEnabledEvents(workItem.id),
      output,
    };
  }

  async getEnabledEvents(workItemId: string): Promise<WorkItemHsmEvent["type"][]> {
    const workItem = this.workItemsService.get(workItemId);
    const candidates: WorkItemHsmEvent["type"][] = [
      "user.start_draft",
      "draft.completed",
      "draft.failed",
      "user.dispatch",
      "run.completed",
      "run.failed",
      "gh.pr_merged",
      "gh.pr_closed",
      "gh.pr_reopened",
      "user.finalize",
      "user.archive_and_finalize",
      "user.defer",
      "user.undefer",
      "user.cancel",
      "user.retry",
    ];
    const enabled: WorkItemHsmEvent["type"][] = [];
    for (const type of candidates) {
      const resolved = await this.resolveTransition(workItem, { type });
      if (resolved) enabled.push(type);
    }
    return enabled;
  }

  private startDraftInvoke(workItem: WorkItemRecord, event: WorkItemHsmEvent): void {
    const handle = this.actions.kickOffPlanDrafter({
      workItem,
      event,
      now: () => new Date().toISOString(),
    });
    const token = Symbol(workItem.id);
    this.activeDraftInvokes.set(workItem.id, { token, handle });

    void handle.completion.finally(() => {
      const current = this.activeDraftInvokes.get(workItem.id);
      if (current?.token === token) {
        this.activeDraftInvokes.delete(workItem.id);
      }
    });
  }

  private cancelDraftInvoke(workItemId: string): void {
    const current = this.activeDraftInvokes.get(workItemId);
    if (!current) return;
    current.handle.cancel();
    this.activeDraftInvokes.delete(workItemId);
  }

  private async runActions(
    actions: ResolvedTransition["entryActions"],
    ctx: HsmActionContext,
    output: Record<string, unknown>,
  ): Promise<UpdateWorkItemDto> {
    let patch: UpdateWorkItemDto = {};
    for (const action of actions ?? []) {
      const result = await action(ctx);
      patch = this.mergePatch(patch, result.patch ?? {});
      Object.assign(output, result.output ?? {});
    }
    return patch;
  }

  private mergePatch(base: UpdateWorkItemDto, incoming: UpdateWorkItemDto): UpdateWorkItemDto {
    const next: UpdateWorkItemDto = { ...base, ...incoming };
    if (base.meta || incoming.meta) {
      next.meta = this.mergeMeta(base.meta ?? {}, incoming.meta ?? {});
    }
    return next;
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

  private async resolveTransition(
    workItem: WorkItemRecord,
    event: WorkItemHsmEvent,
  ): Promise<ResolvedTransition | null> {
    if (this.isPrePrState(workItem.state)) {
      if (event.type === "user.defer") {
        return { target: "deferred", preserveHistory: workItem.state };
      }
      if (event.type === "user.cancel") {
        return { target: "cancelled" };
      }
    }

    switch (workItem.state) {
      case "planned":
        if (event.type === "user.start_draft") return { target: "drafting", startInvoke: true };
        return null;
      case "drafting":
        if (event.type === "draft.completed") return { target: "ready" };
        if (event.type === "draft.failed") return { target: "planned" };
        return null;
      case "ready":
        if (event.type === "user.start_draft") return { target: "drafting", startInvoke: true };
        if (event.type === "user.dispatch") return { target: "in_progress", entryActions: [this.actions.createRunRecord.bind(this.actions)] };
        return null;
      case "in_progress":
        if (event.type === "run.completed") {
          const hasPr = await this.guards.prExistsForBranch({ workItem, event, now: () => new Date().toISOString() });
          return hasPr ? { target: "open_pr" } : { target: "ready" };
        }
        if (event.type === "run.failed") return { target: "run_errored" };
        return null;
      case "run_errored":
        if (event.type === "user.retry") return { target: "ready" };
        if (event.type === "user.start_draft") return { target: "drafting", startInvoke: true };
        return null;
      case "open_pr":
        if (event.type === "gh.pr_merged") {
          return {
            target: "merged_pr",
            entryActions: [this.actions.stampMeta("studio_post_merge_sync")],
          };
        }
        if (event.type === "gh.pr_closed") return { target: "closed" };
        if (event.type === "user.cancel") return { target: "cancelled" };
        return null;
      case "merged_pr":
        if (event.type === "user.finalize") {
          return { target: "done", exitActions: [this.actions.closeGhIssue.bind(this.actions)] };
        }
        if (event.type === "user.archive_and_finalize") {
          return {
            target: "archived",
            exitActions: [this.actions.closeGhIssue.bind(this.actions)],
            entryActions: [this.actions.runArchiver.bind(this.actions)],
          };
        }
        return null;
      case "closed":
        if (event.type === "gh.pr_reopened") return { target: "open_pr" };
        if (event.type === "user.start_draft") return { target: "drafting", startInvoke: true };
        if (event.type === "user.finalize") return { target: "done" };
        if (event.type === "user.archive_and_finalize") {
          return { target: "archived", entryActions: [this.actions.runArchiver.bind(this.actions)] };
        }
        if (event.type === "user.cancel") return { target: "cancelled" };
        return null;
      case "deferred": {
        if (event.type === "user.undefer") {
          const history = this.readPrePrHistory(workItem) ?? "planned";
          return { target: history };
        }
        if (event.type === "user.cancel") return { target: "cancelled" };
        return null;
      }
      case "done":
      case "archived":
      case "cancelled":
        return null;
    }
  }

  private isPrePrState(state: WorkItemState): boolean {
    return state === "planned" || state === "drafting" || state === "ready" || state === "in_progress" || state === "run_errored";
  }

  private readPrePrHistory(workItem: WorkItemRecord): WorkItemState | null {
    const meta = workItem.meta?.hsm_history;
    if (!meta || typeof meta !== "object") return null;
    const value = (meta as Record<string, unknown>).pre_pr;
    return typeof value === "string" ? value as WorkItemState : null;
  }
}
