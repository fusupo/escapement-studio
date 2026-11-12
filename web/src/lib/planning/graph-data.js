import { getExecutionEligibility, getFrontier, getGraph, getHealth, getPlan, getReconciliationReports, listExecutionRuns, listWorkItems } from "../api.js";
/** graph data for the planning workspace. */
export function createGraphData(s, actions) {
    function leafState(state) {
        return state?.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
    }
    function closeGraphContextMenu() {
        s.graphContextMenu = { open: false, x: 0, y: 0, item: null };
    }
    function normalizeLaunchEligibilityError(workItemId, message) {
        return {
            work_item_id: workItemId,
            repo: null,
            issue_url: null,
            issue_backed: false,
            can_launch: false,
            safety_checks: [],
            launch_unavailable_code: "eligibility_lookup_failed",
            launch_unavailable_reason: message,
            dispatch_node: null,
        };
    }
    async function ensurePlanState(workItemId, { force = false } = {}) {
        if (!workItemId)
            return null;
        if (!force && s.planStateById[workItemId] !== undefined) {
            return s.planStateById[workItemId];
        }
        const token = (s.planStateRequestTokenById[workItemId] || 0) + 1;
        s.planStateRequestTokenById = { ...s.planStateRequestTokenById, [workItemId]: token };
        s.planStateLoadingIds = { ...s.planStateLoadingIds, [workItemId]: true };
        try {
            const plan = await getPlan(workItemId);
            if (s.planStateRequestTokenById[workItemId] === token) {
                s.planStateById = { ...s.planStateById, [workItemId]: plan };
            }
            return plan;
        }
        catch (lookupError) {
            const message = lookupError?.message ?? "";
            // 404 = no plan dir yet (expected for planned items). Cache null so
            // we don't re-fetch on every reactive tick.
            if (/No plan found/i.test(message) && s.planStateRequestTokenById[workItemId] === token) {
                s.planStateById = { ...s.planStateById, [workItemId]: null };
            }
            return null;
        }
        finally {
            if (s.planStateRequestTokenById[workItemId] === token) {
                s.planStateLoadingIds = { ...s.planStateLoadingIds, [workItemId]: false };
            }
        }
    }
    async function ensureLaunchEligibility(workItemId, { force = false } = {}) {
        if (!workItemId)
            return null;
        if (!force && s.launchEligibilityById[workItemId]) {
            return s.launchEligibilityById[workItemId];
        }
        const token = (s.launchEligibilityRequestTokenById[workItemId] || 0) + 1;
        s.launchEligibilityRequestTokenById = { ...s.launchEligibilityRequestTokenById, [workItemId]: token };
        s.launchEligibilityLoadingIds = { ...s.launchEligibilityLoadingIds, [workItemId]: true };
        try {
            const eligibility = await getExecutionEligibility({ work_item_id: workItemId });
            if (s.launchEligibilityRequestTokenById[workItemId] === token) {
                s.launchEligibilityById = { ...s.launchEligibilityById, [workItemId]: eligibility };
            }
            return eligibility;
        }
        catch (lookupError) {
            const fallback = actions.normalizeLaunchEligibilityError(workItemId, lookupError.message);
            if (s.launchEligibilityRequestTokenById[workItemId] === token) {
                s.launchEligibilityById = { ...s.launchEligibilityById, [workItemId]: fallback };
            }
            return fallback;
        }
        finally {
            if (s.launchEligibilityRequestTokenById[workItemId] === token) {
                s.launchEligibilityLoadingIds = { ...s.launchEligibilityLoadingIds, [workItemId]: false };
            }
        }
    }
    async function loadGraph() {
        s.loading = true;
        s.error = "";
        try {
            const [graphResponse, healthResponse, catalogResponse] = await Promise.all([
                getGraph(s.filters),
                getHealth(),
                listWorkItems(),
            ]);
            s.graph = graphResponse;
            s.health = healthResponse;
            s.catalog = catalogResponse;
            s.launchEligibilityById = {};
            s.launchEligibilityLoadingIds = {};
            s.launchEligibilityRequestTokenById = {};
            s.planStateById = {};
            s.planStateLoadingIds = {};
            s.planStateRequestTokenById = {};
            if (s.selectedId && !s.graph.items.some((item) => item.id === s.selectedId)) {
                s.selectedId = null;
                actions.closeGraphContextMenu();
            }
        }
        catch (loadError) {
            s.error = loadError.message;
        }
        finally {
            s.loading = false;
        }
    }
    async function loadFrontier() {
        try {
            const repo = s.filters.repo || undefined;
            const frontier = await getFrontier(repo ? { repo } : {});
            s.frontierIds = Array.isArray(frontier) ? frontier.map((item) => item.id) : [];
        }
        catch {
            s.frontierIds = [];
        }
    }
    async function loadExecutionStats() {
        try {
            s.executionRuns = await listExecutionRuns();
        }
        catch {
            s.executionRuns = [];
        }
    }
    async function loadReconciliationStats() {
        try {
            s.reconciliationReports = await getReconciliationReports();
        }
        catch {
            s.reconciliationReports = [];
        }
    }
    async function refresh() {
        await actions.loadGraph();
        if (s.activeTab === "planning")
            void actions.loadFrontier();
        if (s.activeTab === "execute")
            void actions.loadExecutionStats();
        if (s.activeTab === "reconciliation")
            void actions.loadReconciliationStats();
    }
    async function runGraphRefresh() {
        if (s.graphRefreshInFlight) {
            return;
        }
        s.graphRefreshInFlight = true;
        try {
            await actions.refresh();
        }
        finally {
            s.graphRefreshInFlight = false;
        }
    }
    function scheduleGraphRefresh() {
        window.clearTimeout(s.graphRefreshTimer);
        s.graphRefreshTimer = window.setTimeout(() => {
            s.graphRefreshTimer = null;
            void actions.runGraphRefresh();
        }, 150);
    }
    function handleFilterChange(nextFilters) {
        s.filters = nextFilters;
        actions.loadGraph();
    }
    function resetFilters() {
        s.filters = { repo: "", state: "", track: "", phase: "" };
        actions.loadGraph();
    }
    return { leafState, closeGraphContextMenu, normalizeLaunchEligibilityError, ensurePlanState, ensureLaunchEligibility, loadGraph, loadFrontier, loadExecutionStats, loadReconciliationStats, refresh, runGraphRefresh, scheduleGraphRefresh, handleFilterChange, resetFilters };
}
