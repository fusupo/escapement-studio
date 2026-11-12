import { onMount, untrack } from 'svelte';
import { buildGraphNodeContextMenu } from "../graph-node-actions.js";
import { createGraphData } from "./graph-data.js";
import { createWorkItemActions } from "./work-item-actions.js";
import { createPlanActions } from "./plan-actions.js";
import { createPaneInteractions } from "./pane-interactions.js";
/** Owns reactive workspace state and lifecycle; actions live in focused modules. */
export function createWorkspace() {
    const emptyGraph = { filters: {}, items: [], edges: [] };
    const MIN_PANE = 200;
    const MAX_PANE = 600;
    const activityItems = [
        { id: "planning", label: "Planning", icon: "plan" },
        { id: "execute", label: "Execute", icon: "execute" },
        { id: "reconciliation", label: "Reconcile", icon: "reconcile" },
        { id: "settings", label: "Settings", icon: "settings" },
    ];
    /** @type {ReturnType<typeof createGraphData> & ReturnType<typeof createWorkItemActions> & ReturnType<typeof createPlanActions> & ReturnType<typeof createPaneInteractions>} */
    const actions = /** @type {any} */ ({});
    const s = $state({
        graph: emptyGraph,
        catalog: [],
        filters: { repo: "", state: "", track: "", phase: "" },
        selectedId: null,
        loading: true,
        saving: false,
        edgeSaving: false,
        error: "",
        notice: "",
        health: null,
        activeTab: "planning",
        closingIssue: false,
        archivingWorkItem: false,
        cancelingWorkItem: false,
        deletingWorkItem: false,
        launchingExecution: false,
        launchEligibilityById: {},
        launchEligibilityLoadingIds: {},
        launchEligibilityRequestTokenById: {},
        graphContextMenu: { open: false, x: 0, y: 0, item: null },
        graphStream: null,
        graphRefreshTimer: null,
        graphRefreshInFlight: false,
        frontierIds: [],
        executionRuns: [],
        reconciliationReports: [],
        lastExecutionFetchTab: null,
        lastReconciliationFetchTab: null,
        preparingPlan: false,
        approvingPlan: false,
        planStateById: {},
        planStateLoadingIds: {},
        planStateRequestTokenById: {},
        planReview: null,
        cancelDialog: null,
        deleteDialog: null,
        chatCollapsed: false,
        sidebarCollapsed: false,
        chatWidth: 360,
        sidebarWidth: 320,
        dragging: null,
        dragStartX: 0,
        dragStartWidth: 0,
        emptyGraph, MIN_PANE, MAX_PANE, activityItems,
        get selectedItem() { return s.graph.items.find((item) => item.id === s.selectedId) ?? null; },
        get selectedLaunchEligibility() { return s.selectedItem ? s.launchEligibilityById[s.selectedItem.id] ?? null : null; },
        get selectedLaunchEligibilityLoading() { return s.selectedItem ? !!s.launchEligibilityLoadingIds[s.selectedItem.id] : false; },
        get contextMenuLaunchEligibility() { return s.graphContextMenu.item ? s.launchEligibilityById[s.graphContextMenu.item.id] ?? null : null; },
        get contextMenuLaunchEligibilityLoading() { return s.graphContextMenu.item ? !!s.launchEligibilityLoadingIds[s.graphContextMenu.item.id] : false; },
        get contextMenuPlanState() {
            return s.graphContextMenu.item
                ? s.planStateById[s.graphContextMenu.item.id]?.metadata ?? null
                : null;
        },
        get contextMenuPlanStateLoading() {
            return s.graphContextMenu.item
                ? !!s.planStateLoadingIds[s.graphContextMenu.item.id]
                : false;
        },
        get graphContextMenuModel() {
            return buildGraphNodeContextMenu({
                item: s.graphContextMenu.item,
                launchEligibility: s.contextMenuLaunchEligibility,
                launchEligibilityLoading: s.contextMenuLaunchEligibilityLoading,
                launchingExecution: s.launchingExecution,
                planState: s.contextMenuPlanState,
                planStateLoading: s.contextMenuPlanStateLoading,
                preparingPlan: s.preparingPlan,
                approvingPlan: s.approvingPlan,
                cancelingWorkItem: s.cancelingWorkItem,
                deletingWorkItem: s.deletingWorkItem,
                connectedEdges: s.graphContextMenu.item
                    ? s.graph.edges.filter((edge) => edge.from_id === s.graphContextMenu.item.id || edge.to_id === s.graphContextMenu.item.id)
                    : [],
            });
        },
        get filterOptions() {
            return {
                repos: [...new Set(s.catalog.map((item) => item.repo).filter(Boolean))].sort(),
                states: [...new Set(s.catalog.map((item) => item.state).filter(Boolean))].sort(),
                tracks: s.catalog.filter((item) => item.kind === "track"),
                phases: s.catalog.filter((item) => item.kind === "phase"),
            };
        },
        get activeFilterCount() { return Object.values(s.filters).filter(Boolean).length; },
        get frontierCount() { return s.frontierIds.length; },
        get blockedCount() {
            return (() => {
                const frontierSet = new Set(s.frontierIds);
                return s.graph.items.filter((item) => {
                    const leaf = item.state?.startsWith("pre_pr.") ? item.state.slice("pre_pr.".length) : item.state;
                    return leaf === "planned" && !frontierSet.has(item.id);
                }).length;
            })();
        },
        get activeRunCount() {
            return s.executionRuns.filter((r) => ["queued", "preparing", "running", "disambiguating"].includes(r.status)).length;
        },
        get completedTodayCount() {
            return (() => {
                const todayPrefix = new Date().toISOString().slice(0, 10);
                return s.executionRuns.filter((r) => r.status === "completed" && r.terminal_outcome?.severity !== "warn" && r.completed_at?.startsWith(todayPrefix)).length;
            })();
        },
        get successRate() {
            return (() => {
                const completed = s.executionRuns.filter((r) => r.status === "completed" && r.terminal_outcome?.severity !== "warn").length;
                const errored = s.executionRuns.filter((r) => r.status === "error").length;
                const total = completed + errored;
                return total > 0 ? Math.round((completed / total) * 100) : null;
            })();
        },
        get readyToMergeCount() {
            return Array.isArray(s.reconciliationReports)
                ? s.reconciliationReports.filter((r) => {
                    const stats = r.stats || {};
                    return stats.missed_count === 0 && stats.unpredicted_count === 0;
                }).length
                : 0;
        },
        get conflictsCount() {
            return Array.isArray(s.reconciliationReports)
                ? s.reconciliationReports.filter((r) => (r.stats?.missed_count ?? 0) > 0 || (r.stats?.unpredicted_count ?? 0) > 0).length
                : 0;
        },
        get staleCount() {
            return Array.isArray(s.reconciliationReports)
                ? s.reconciliationReports.filter((r) => (r.drift_patterns?.length ?? 0) > 0).length
                : 0;
        }
    });
    Object.assign(actions, createGraphData(s, actions));
    Object.assign(actions, createWorkItemActions(s, actions));
    Object.assign(actions, createPlanActions(s, actions));
    Object.assign(actions, createPaneInteractions(s, actions));
    $effect(() => { const tab = s.activeTab; untrack(() => { if (tab === 'planning')
        void actions.loadFrontier(); if (tab === 'execute')
        void actions.loadExecutionStats(); if (tab === 'reconciliation')
        void actions.loadReconciliationStats(); }); });
    $effect(() => { const item = s.selectedItem; untrack(() => { if (item?.id) {
        void actions.ensureLaunchEligibility(item.id);
        if (item.kind === 'issue' && ['drafting', 'ready', 'in_progress', 'open_pr', 'merged_pr'].includes(actions.leafState(item.state)))
            void actions.ensurePlanState(item.id);
    } }); });
    onMount(() => () => actions.onDragEnd());
    onMount(() => {
        void actions.loadGraph();
        s.graphStream = new EventSource("/api/graph/stream");
        s.graphStream.addEventListener("work_item_state_changed", () => {
            actions.scheduleGraphRefresh();
        });
        return () => {
            window.clearTimeout(s.graphRefreshTimer);
            s.graphStream?.close();
        };
    });
    return Object.assign(s, actions);
}
