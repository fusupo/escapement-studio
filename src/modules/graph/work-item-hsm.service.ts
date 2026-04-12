import { BadRequestException, Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { Statechart } from "@scion-scxml/core";
import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphWriterService } from "./graph-writer.service.js";
import type { ApplyGraphMutationsResult } from "./types.js";
import type {
  DispatchResult,
  HsmActionHandler,
  HsmLeafState,
  PersistedDeferredState,
  PersistedPrePrState,
  UpdateWorkItemDto,
  WorkItemHsmEvent,
  WorkItemRecord,
  WorkItemState,
} from "./types.js";
import { WorkItemsService } from "./work-items.service.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHART_PATH = resolve(MODULE_DIR, "work-item.scxml");
const PRE_PR_LEAF_STATES = ["planned", "drafting", "ready", "in_progress", "run_errored"] as const;
const USER_EVENT_PREFIX = "user.";
const PRE_PR_HISTORY_ID = "pre_pr_history";
const HSM_META_KEY = "studio_hsm";

type PrePrLeafState = (typeof PRE_PR_LEAF_STATES)[number];

type Snapshot = [string[], Record<string, string[]>, boolean, null, unknown[]];

interface ParsedTransition {
  event: string;
  target: string;
  cond?: string;
  actions: string[];
}

interface ParsedState {
  id: string;
  initial?: string;
  final?: boolean;
  onEntryActions: string[];
  transitions: ParsedTransition[];
  states: ParsedState[];
  history?: {
    id: string;
    type: "shallow" | "deep";
    target: string;
  };
}

interface ParsedChart {
  initial: string;
  states: ParsedState[];
}

interface RuntimeContext {
  actions: string[];
  meta: Record<string, unknown>;
  handler_data: Record<string, unknown>;
  patch_overrides: Partial<UpdateWorkItemDto>;
  event: WorkItemHsmEvent;
  prevState: WorkItemState;
}

@Injectable()
export class WorkItemHsmService implements OnModuleInit {
  private readonly logger = new Logger(WorkItemHsmService.name);
  private readonly chartPath = DEFAULT_CHART_PATH;
  private chart!: ParsedChart;
  private stateById = new Map<string, ParsedState>();
  private parentById = new Map<string, string | null>();
  private readonly actionHandlers = new Map<string, HsmActionHandler>();

  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
  ) {}

  onModuleInit(): void {
    const xml = readFileSync(this.chartPath, "utf8");
    const chart = this.parseChart(xml);
    this.buildIndexes(chart);

    // Fail startup loudly if the chart cannot be materialized into a SCION model.
    const machine = new Statechart(this.toScionModel(chart, {
      actions: [],
      meta: {},
      handler_data: {},
      patch_overrides: {},
      event: { type: "user.start_draft" },
      prevState: "planned",
    }));
    machine.start();

    this.chart = chart;
  }

  registerActionHandler(actionName: string, handler: HsmActionHandler): void {
    if (this.actionHandlers.has(actionName)) {
      throw new Error(`HSM action handler already registered: ${actionName}`);
    }
    this.actionHandlers.set(actionName, handler);
  }

  async dispatch(workItemId: string, event: WorkItemHsmEvent): Promise<DispatchResult> {
    this.ensureInitialized();

    const workItem = this.workItems.get(workItemId);
    const prevState = this.normalizePersistedState(workItem.state);
    const runtime = this.createRuntimeContext(workItem, event, prevState);
    const transition = this.selectTransition(prevState, event);

    if (!transition) {
      this.logger.debug(`Event ${event.type} rejected by HSM for ${workItemId} from ${prevState}`);
      return {
        work_item_id: workItemId,
        prev_state: prevState,
        next_state: prevState,
        event,
        applied_actions: [],
        mutation_applied: false,
        rejected: true,
      };
    }

    const resolvedTarget = this.resolveTransitionTarget(transition.target, workItem.meta);
    const nextState = this.persistLeafState(resolvedTarget);

    for (const action of transition.actions) {
      this.applyAction(action, runtime);
    }
    for (const action of this.stateById.get(resolvedTarget)?.onEntryActions ?? []) {
      this.applyAction(action, runtime);
    }

    // Execute registered async side-effect handlers BEFORE the state write.
    // If any handler throws, abort — state unchanged.
    for (const action of runtime.actions) {
      const handler = this.actionHandlers.get(action);
      if (handler) {
        await handler(workItem, event, {
          meta: runtime.meta,
          handler_data: runtime.handler_data,
          patch_overrides: runtime.patch_overrides,
        });
      }
    }

    this.clearDeferredHistoryIfNeeded(runtime.meta, prevState, nextState);

    const patch: UpdateWorkItemDto = { state: nextState, ...runtime.patch_overrides };
    if (JSON.stringify(runtime.meta) !== JSON.stringify(workItem.meta)) {
      patch.meta = runtime.meta;
    }

    const result = this.graphWriter.apply({
      mutations: [{ kind: "update_work_item", id: workItemId, patch }],
    });

    this.assertApplied(result);

    return {
      work_item_id: workItemId,
      prev_state: prevState,
      next_state: nextState,
      event,
      applied_actions: runtime.actions,
      mutation_applied: true,
      rejected: false,
      handler_data: Object.keys(runtime.handler_data).length > 0 ? runtime.handler_data : undefined,
    };
  }

  getEnabledEvents(workItemId: string): WorkItemHsmEvent["type"][] {
    this.ensureInitialized();

    const workItem = this.workItems.get(workItemId);
    const leafState = this.activeLeafId(this.normalizePersistedState(workItem.state));
    const enabled = new Set<string>();

    for (const state of this.ancestryForState(leafState)) {
      for (const transition of state.transitions) {
        if (transition.event.startsWith(USER_EVENT_PREFIX)) {
          enabled.add(transition.event);
        }
      }
    }

    return Array.from(enabled) as WorkItemHsmEvent["type"][];
  }

  private ensureInitialized() {
    if (!this.chart) {
      this.onModuleInit();
    }
  }

  private createRuntimeContext(
    workItem: WorkItemRecord,
    event: WorkItemHsmEvent,
    prevState: WorkItemState,
  ): RuntimeContext {
    return {
      actions: [],
      meta: this.cloneMeta(workItem.meta),
      handler_data: {},
      patch_overrides: {},
      event,
      prevState,
    };
  }

  private createInterpreter(runtime: RuntimeContext, workItem: WorkItemRecord) {
    const snapshot = this.snapshotFor(workItem);
    const model = this.toScionModel(this.chart, runtime);
    return snapshot ? new Statechart(model, { snapshot: snapshot as never }) : new Statechart(model);
  }

  private snapshotFor(workItem: WorkItemRecord): Snapshot | null {
    const persistedState = this.normalizePersistedState(workItem.state);
    const activeLeaf = this.activeLeafId(persistedState);
    const history = this.historySnapshotFor(workItem, persistedState);
    return [[activeLeaf], history, false, null, []];
  }

  private historySnapshotFor(
    workItem: WorkItemRecord,
    persistedState: WorkItemState,
  ): Record<string, string[]> {
    if (persistedState !== "deferred") {
      return {};
    }

    const deferredFrom = this.readDeferredFromState(workItem.meta);
    if (!deferredFrom) {
      return {};
    }

    return { [PRE_PR_HISTORY_ID]: [this.activeLeafId(deferredFrom)] };
  }

  private toScionModel(chart: ParsedChart, runtime: RuntimeContext) {
    return {
      id: "work_item",
      initial: chart.initial,
      states: chart.states.map((state) => this.toScionState(state, runtime)),
    };
  }

  private toScionState(state: ParsedState, runtime: RuntimeContext) {
    const scionState: Record<string, unknown> = {
      id: state.id,
    };

    if (state.initial) {
      scionState.initial = state.initial;
    }
    if (state.final) {
      scionState.$type = "final";
    }
    if (state.onEntryActions.length > 0) {
      scionState.onEntry = () => {
        for (const action of state.onEntryActions) {
          this.applyAction(action, runtime);
        }
      };
    }

    const childStates = [...state.states.map((child) => this.toScionState(child, runtime))];
    if (state.history) {
      childStates.unshift({
        $type: "history",
        id: state.history.id,
        isDeep: state.history.type === "deep",
        transitions: [{ target: state.history.target }],
      });
    }
    if (childStates.length > 0) {
      scionState.states = childStates;
    }

    if (state.transitions.length > 0) {
      scionState.transitions = state.transitions.map((transition) => ({
        event: transition.event,
        target: transition.target,
        cond: transition.cond
          ? (scionEvent: { data?: WorkItemHsmEvent }) => this.evaluateCondition(transition.cond!, scionEvent?.data)
          : undefined,
        onTransition: () => {
          for (const action of transition.actions) {
            this.applyAction(action, runtime);
          }
        },
      }));
    }

    return scionState;
  }

  private evaluateCondition(cond: string, event: WorkItemHsmEvent | undefined): boolean {
    switch (cond) {
      case "pr_exists":
        return event?.type === "run.completed" && event.pr_exists === true;
      case "!pr_exists":
        return event?.type === "run.completed" && event.pr_exists === false;
      default:
        throw new Error(`Unsupported SCXML condition: ${cond}`);
    }
  }

  private applyAction(action: string, runtime: RuntimeContext) {
    runtime.actions.push(action);

    if (action === "rememberHistory") {
      const studioHsm = this.ensureMetaObject(runtime.meta, HSM_META_KEY);
      studioHsm.deferred_from_state = runtime.prevState;
      return;
    }

    if (!action.startsWith("stampMeta:")) {
      return;
    }

    const key = action.slice("stampMeta:".length);
    runtime.meta[key] = this.buildMetaPayload(key, runtime.event);
  }

  private buildMetaPayload(key: string, event: WorkItemHsmEvent): Record<string, unknown> {
    switch (key) {
      case "studio_open_pr_sync":
        return {
          source_event: event.type,
          pull_request: event.type === "gh.pr_opened" ? event.pull_request : null,
        };
      case "studio_post_merge_sync":
        return {
          source_event: event.type,
          pull_request: event.type === "gh.pr_merged" ? event.pull_request : null,
        };
      case "studio_issue_close_sync":
        return {
          source_event: event.type,
          issue: event.type === "gh.issue_closed" ? event.issue : null,
        };
      default:
        return { source_event: event.type };
    }
  }

  private clearDeferredHistoryIfNeeded(meta: Record<string, unknown>, prevState: WorkItemState, nextState: WorkItemState) {
    if (prevState !== "deferred" || !nextState.startsWith("pre_pr.")) {
      return;
    }

    const studioHsm = meta[HSM_META_KEY];
    if (!studioHsm || typeof studioHsm !== "object") {
      return;
    }

    delete (studioHsm as Record<string, unknown>).deferred_from_state;
  }

  private parseChart(xml: string): ParsedChart {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      allowBooleanAttributes: true,
    });
    const parsed = parser.parse(xml) as {
      scxml?: {
        initial?: string;
        state?: unknown;
      };
    };

    if (!parsed.scxml?.initial) {
      throw new Error("work-item.scxml must define an <scxml initial=...> root");
    }

    return {
      initial: parsed.scxml.initial,
      states: this.asArray(parsed.scxml.state).map((state) => this.parseState(state)),
    };
  }

  private parseState(input: unknown): ParsedState {
    const node = input as {
      id?: string;
      initial?: string;
      final?: boolean | string;
      onentry?: string;
      transition?: unknown;
      state?: unknown;
      history?: unknown;
    };

    if (!node.id) {
      throw new Error("Every <state> in work-item.scxml must define id");
    }

    const historyNode = node.history
      ? (Array.isArray(node.history) ? node.history[0] : node.history)
      : undefined;
    const parsedHistory = historyNode
      ? this.parseHistory(historyNode as { id?: string; type?: string; transition?: unknown })
      : undefined;

    return {
      id: node.id,
      initial: node.initial,
      final: node.final === true || node.final === "true",
      onEntryActions: this.parseActionList(node.onentry),
      transitions: this.asArray(node.transition).map((transition) => this.parseTransition(transition)),
      states: this.asArray(node.state).map((state) => this.parseState(state)),
      history: parsedHistory,
    };
  }

  private parseHistory(input: { id?: string; type?: string; transition?: unknown }): ParsedState["history"] {
    const transition = this.asArray(input.transition)[0] as { target?: string } | undefined;
    if (!input.id || !transition?.target) {
      throw new Error("<history> must define id and a default transition target");
    }

    return {
      id: input.id,
      type: input.type === "deep" ? "deep" : "shallow",
      target: transition.target,
    };
  }

  private parseTransition(input: unknown): ParsedTransition {
    const node = input as { event?: string; target?: string; cond?: string; action?: string };
    if (!node.event || !node.target) {
      throw new Error("Every <transition> in work-item.scxml must define event and target");
    }

    return {
      event: node.event,
      target: node.target,
      cond: node.cond,
      actions: this.parseActionList(node.action),
    };
  }

  private parseActionList(value: string | undefined): string[] {
    return value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ?? [];
  }

  private buildIndexes(chart: ParsedChart) {
    this.stateById = new Map<string, ParsedState>();
    this.parentById = new Map<string, string | null>();

    const walk = (state: ParsedState, parentId: string | null) => {
      this.stateById.set(state.id, state);
      this.parentById.set(state.id, parentId);
      for (const child of state.states) {
        walk(child, state.id);
      }
    };

    for (const state of chart.states) {
      walk(state, null);
    }
  }

  private ancestryForState(stateId: string): ParsedState[] {
    const ancestry: ParsedState[] = [];
    let currentId: string | null = stateId;

    while (currentId) {
      const state = this.stateById.get(currentId);
      if (!state) {
        break;
      }
      ancestry.push(state);
      currentId = this.parentById.get(currentId) ?? null;
    }

    return ancestry;
  }

  private selectTransition(state: WorkItemState, event: WorkItemHsmEvent): ParsedTransition | null {
    const leafState = this.activeLeafId(state);

    for (const current of this.ancestryForState(leafState)) {
      for (const transition of current.transitions) {
        if (transition.event !== event.type) {
          continue;
        }
        if (transition.cond && !this.evaluateCondition(transition.cond, event)) {
          continue;
        }
        return transition;
      }
    }

    return null;
  }

  private resolveTransitionTarget(target: string, meta: Record<string, unknown>): HsmLeafState {
    if (target === PRE_PR_HISTORY_ID) {
      const deferredFrom = this.readDeferredFromState(meta);
      return deferredFrom ? this.activeLeafId(deferredFrom) : "planned";
    }

    return target as HsmLeafState;
  }

  private persistLeafState(leaf: HsmLeafState): WorkItemState {
    if ((PRE_PR_LEAF_STATES as readonly string[]).includes(leaf)) {
      return `pre_pr.${leaf as PrePrLeafState}`;
    }
    return leaf;
  }

  private activeLeafId(state: WorkItemState): HsmLeafState {
    if (state.startsWith("pre_pr.")) {
      return state.slice("pre_pr.".length) as HsmLeafState;
    }
    return state as HsmLeafState;
  }

  private normalizePersistedState(state: WorkItemState): WorkItemState {
    if ((PRE_PR_LEAF_STATES as readonly string[]).includes(state)) {
      return `pre_pr.${state as PrePrLeafState}`;
    }
    return state;
  }

  private persistedStateFromConfiguration(configuration: string[]): WorkItemState {
    const leaf = configuration[0] as HsmLeafState | undefined;
    if (!leaf) {
      throw new Error("SCION returned an empty configuration");
    }

    if ((PRE_PR_LEAF_STATES as readonly string[]).includes(leaf)) {
      return `pre_pr.${leaf as PrePrLeafState}` satisfies PersistedPrePrState;
    }

    return leaf satisfies Exclude<WorkItemState, PersistedPrePrState | PersistedDeferredState> | PersistedDeferredState;
  }

  private readDeferredFromState(meta: Record<string, unknown>): WorkItemState | null {
    const studioHsm = meta[HSM_META_KEY];
    if (!studioHsm || typeof studioHsm !== "object") {
      return null;
    }

    const value = (studioHsm as Record<string, unknown>).deferred_from_state;
    return typeof value === "string" ? (this.normalizePersistedState(value as WorkItemState) as WorkItemState) : null;
  }

  private ensureMetaObject(meta: Record<string, unknown>, key: string): Record<string, unknown> {
    const current = meta[key];
    if (current && typeof current === "object") {
      return current as Record<string, unknown>;
    }

    const next: Record<string, unknown> = {};
    meta[key] = next;
    return next;
  }

  private cloneMeta(meta: Record<string, unknown>): Record<string, unknown> {
    return typeof structuredClone === "function"
      ? structuredClone(meta)
      : (JSON.parse(JSON.stringify(meta)) as Record<string, unknown>);
  }

  private assertApplied(result: ApplyGraphMutationsResult) {
    if (result.status === "applied") {
      return;
    }

    if (result.status === "validation_failed") {
      throw new BadRequestException(result.errors[0]?.message ?? "HSM mutation validation failed");
    }

    throw new BadRequestException(result.message);
  }

  private asArray<T>(value: T | T[] | undefined): T[] {
    if (value == null) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }
}
