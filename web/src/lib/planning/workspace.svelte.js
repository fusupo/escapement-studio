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
    // Server snapshots are replaced wholesale, never mutated in place. Keep them
    // raw (unproxied) so components don't deep-walk them on every update.
    /** @type {{ filters: any, items: any[], edges: any[], graph_version?: string }} */
    let graph = $state.raw(emptyGraph);
    /** @type {any[]} */
    let catalog = $state.raw([]);
    /** @type {any[]} */
    let executionRuns = $state.raw([]);
    /** @type {any} */
    let reconciliationReports = $state.raw([]);
    const s = $state({
        get graph() { return graph; },
        set graph(value) { graph = value; },
        get catalog() { return catalog; },
        set catalog(value) { catalog = value; },
        get executionRuns() { return executionRuns; },
        set executionRuns(value) { executionRuns = value; },
        get reconciliationReports() { return reconciliationReports; },
        set reconciliationReports(value) { reconciliationReports = value; },
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
        // Derived views are cached ($derived below); plain getters recomputed
        // on every template read.
        get selectedItem() { return selectedItem; },
        get selectedLaunchEligibility() { return selectedLaunchEligibility; },
        get selectedLaunchEligibilityLoading() { return selectedLaunchEligibilityLoading; },
        get contextMenuLaunchEligibility() { return contextMenuLaunchEligibility; },
        get contextMenuLaunchEligibilityLoading() { return contextMenuLaunchEligibilityLoading; },
        get contextMenuPlanState() { return contextMenuPlanState; },
        get contextMenuPlanStateLoading() { return contextMenuPlanStateLoading; },
        get graphContextMenuModel() { return graphContextMenuModel; },
        get filterOptions() { return filterOptions; },
        get activeFilterCount() { return activeFilterCount; },
        get frontierCount() { return s.frontierIds.length; },
        get blockedCount() { return blockedCount; },
        get activeRunCount() { return activeRunCount; },
        get completedTodayCount() { return completedTodayCount; },
        get successRate() { return successRate; },
        get readyToMergeCount() { return readyToMergeCount; },
        get conflictsCount() { return conflictsCount; },
        get staleCount() { return staleCount; },
    });
    const selectedItem = $derived(graph.items.find((item) => item.id === s.selectedId) ?? null);
    const selectedLaunchEligibility = $derived(selectedItem ? s.launchEligibilityById[selectedItem.id] ?? null : null);
    const selectedLaunchEligibilityLoading = $derived(selectedItem ? !!s.launchEligibilityLoadingIds[selectedItem.id] : false);
    const contextMenuItem = $derived(s.graphContextMenu.item);
    const contextMenuLaunchEligibility = $derived(contextMenuItem ? s.launchEligibilityById[contextMenuItem.id] ?? null : null);
    const contextMenuLaunchEligibilityLoading = $derived(contextMenuItem ? !!s.launchEligibilityLoadingIds[contextMenuItem.id] : false);
    const contextMenuPlanState = $derived(contextMenuItem ? s.planStateById[contextMenuItem.id]?.metadata ?? null : null);
    const contextMenuPlanStateLoading = $derived(contextMenuItem ? !!s.planStateLoadingIds[contextMenuItem.id] : false);
    const graphContextMenuModel = $derived(buildGraphNodeContextMenu({
        item: contextMenuItem,
        launchEligibility: contextMenuLaunchEligibility,
        launchEligibilityLoading: contextMenuLaunchEligibilityLoading,
        launchingExecution: s.launchingExecution,
        planState: contextMenuPlanState,
        planStateLoading: contextMenuPlanStateLoading,
        preparingPlan: s.preparingPlan,
        approvingPlan: s.approvingPlan,
        cancelingWorkItem: s.cancelingWorkItem,
        deletingWorkItem: s.deletingWorkItem,
        connectedEdges: contextMenuItem
            ? graph.edges.filter((edge) => edge.from_id === contextMenuItem.id || edge.to_id === contextMenuItem.id)
            : [],
    }));
    const filterOptions = $derived({
        repos: [...new Set(catalog.map((item) => item.repo).filter(Boolean))].sort(),
        states: [...new Set(catalog.map((item) => item.state).filter(Boolean))].sort(),
        tracks: catalog.filter((item) => item.kind === "track"),
        phases: catalog.filter((item) => item.kind === "phase"),
    });
    const activeFilterCount = $derived(Object.values(s.filters).filter(Boolean).length);
    const blockedCount = $derived.by(() => {
        const frontierSet = new Set(s.frontierIds);
        return graph.items.filter((item) => {
            const leaf = item.state?.startsWith("pre_pr.") ? item.state.slice("pre_pr.".length) : item.state;
            return leaf === "planned" && !frontierSet.has(item.id);
        }).length;
    });
    const activeRunCount = $derived(executionRuns.filter((r) => ["queued", "preparing", "running", "disambiguating"].includes(r.status)).length);
    const completedTodayCount = $derived.by(() => {
        const todayPrefix = new Date().toISOString().slice(0, 10);
        return executionRuns.filter((r) => r.status === "completed" && r.terminal_outcome?.severity !== "warn" && r.completed_at?.startsWith(todayPrefix)).length;
    });
    const successRate = $derived.by(() => {
        const completed = executionRuns.filter((r) => r.status === "completed" && r.terminal_outcome?.severity !== "warn").length;
        const errored = executionRuns.filter((r) => r.status === "error").length;
        const total = completed + errored;
        return total > 0 ? Math.round((completed / total) * 100) : null;
    });
    const readyToMergeCount = $derived(Array.isArray(reconciliationReports)
        ? reconciliationReports.filter((r) => {
            const stats = r.stats || {};
            return stats.missed_count === 0 && stats.unpredicted_count === 0;
        }).length
        : 0);
    const conflictsCount = $derived(Array.isArray(reconciliationReports)
        ? reconciliationReports.filter((r) => (r.stats?.missed_count ?? 0) > 0 || (r.stats?.unpredicted_count ?? 0) > 0).length
        : 0);
    const staleCount = $derived(Array.isArray(reconciliationReports)
        ? reconciliationReports.filter((r) => (r.drift_patterns?.length ?? 0) > 0).length
        : 0);
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
    /**
     * Apply UI state changes from view components. Writing through the owning
     * module (rather than mutating the `workspace` prop) keeps Svelte's prop
     * ownership rules intact.
     * @param {Partial<typeof s>} patch
     */
    function assign(patch) { Object.assign(s, patch); }
    return Object.assign(s, actions, { assign });
}
