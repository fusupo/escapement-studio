import { Injectable } from "@nestjs/common";
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
  async createRunRecord(_ctx: HsmActionContext): Promise<HsmActionResult> {
    return {};
  }

  stampMeta(blockName: string) {
    return async (_ctx: HsmActionContext): Promise<HsmActionResult> => {
      void blockName;
      return {};
    };
  }

  async closeGhIssue(_ctx: HsmActionContext): Promise<HsmActionResult> {
    return {};
  }

  async runArchiver(_ctx: HsmActionContext): Promise<HsmActionResult> {
    return {};
  }

  kickOffPlanDrafter(_ctx: HsmActionContext): PlanDraftInvokeHandle {
    return {
      sessionId: null,
      completion: Promise.resolve(),
      cancel: () => {},
    };
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
