import { onMount, untrack } from 'svelte';
import { createExecutionSyncCoordinator } from "../execution-sync.js";
import { shouldReplaceChecklistSnapshot } from "../checklist-sync.js";
import { projectExecutionRecovery } from "../execution-recovery.js";
import { createRunData } from "./run-data.js";
import { createRunActions } from "./run-actions.js";
import { createRefinementActions } from "./refinement-actions.js";
import { createActivity } from "./activity.js";
/** Owns reactive workspace state and lifecycle; actions live in focused modules. */
export function createWorkspace() {
    const REFINEMENT_DRAFTS_KEY = "escapement.execution.refinement-drafts";
    const turnColors = [
        "rgba(37, 99, 235, 0.04)",
        "rgba(63, 185, 80, 0.04)",
        "rgba(163, 113, 247, 0.04)",
        "rgba(210, 153, 34, 0.04)",
    ];
    const COLLAPSE_LINE_THRESHOLD = 6;
    /** @type {ReturnType<typeof createRunData> & ReturnType<typeof createRunActions> & ReturnType<typeof createRefinementActions> & ReturnType<typeof createActivity>} */
    const actions = /** @type {any} */ ({});
    // Server snapshots are replaced wholesale, never mutated in place. Keep them
    // raw (unproxied): runs carry activity logs of hundreds of KB, and deep
    // proxies over them made every stream event re-walk the whole tree.
    /** @type {any} */
    let preview = $state.raw(null);
    /** @type {any[]} */
    let runs = $state.raw([]);
    /** @type {any[]} */
    let archivedBundles = $state.raw([]);
    /** @type {Record<string, any>} */
    let reconciledByWorkItem = $state.raw({});
    const s = $state({
        get preview() { return preview; },
        set preview(value) { preview = value; },
        get runs() { return runs; },
        set runs(value) { runs = value; },
        get archivedBundles() { return archivedBundles; },
        set archivedBundles(value) { archivedBundles = value; },
        get reconciledByWorkItem() { return reconciledByWorkItem; },
        set reconciledByWorkItem(value) { reconciledByWorkItem = value; },
        archivedLoading: false,
        archivedError: "",
        loading: true,
        refreshing: false,
        connected: false,
        syncStatus: "idle",
        lastSuccessfulSyncAt: null,
        syncError: null,
        syncCoordinator: null,
        error: "",
        copiedMessage: "",
        copyTimer: null,
        stream: null,
        launchingIds: [],
        fastForwardPending: {},
        fastForwardErrors: {},
        openingPrRunIds: [],
        disposingRunIds: [],
        dispositionErrors: {},
        recoveryByWorkItem: {},
        recoveryRequestTokens: {},
        recoveryLookupKey: null,
        prResults: {},
        followUpTexts: {},
        sendingFollowUp: {},
        resolvingDisambiguation: {},
        disambiguationContext: {},
        refinementResponses: {},
        confirmUnresolved: {},
        refinementDrawerWidths: {},
        refinementDrawerClosed: {},
        refinementDrawerResizeCleanup: null,
        scratchpadContent: {},
        scratchpadLoading: {},
        checklistData: {},
        feedScrollEl: null,
        prevActivityCount: 0,
        selectedRunId: null,
        selectedDispatchId: null,
        activeSelection: "run",
        expandedMessages: {},
        REFINEMENT_DRAFTS_KEY, turnColors, COLLAPSE_LINE_THRESHOLD,
        // Derived views are cached ($derived below); plain getters recomputed
        // on every template read.
        get activeRuns() { return activeRuns; },
        get disambiguatingRuns() { return disambiguatingRuns; },
        get completedRuns() { return completedRuns; },
        get suspectRuns() { return suspectRuns; },
        get blockedRuns() { return blockedRuns; },
        get failedRuns() { return failedRuns; },
        get syncTone() { return syncTone; },
        get syncLabel() { return syncLabel; },
        get dispatchNodes() { return dispatchNodes; },
        get selectedRun() { return selectedRun; },
        get selectedDispatch() { return selectedDispatch; },
        get selectedPullRequest() { return selectedPullRequest; },
        get selectedRecoveryData() { return selectedRecoveryData; },
        get selectedRecovery() { return selectedRecovery; },
        get selectedRunTurnGroups() { return selectedRunTurnGroups; },
    });
    const activeRuns = $derived(runs.filter((run) => ["queued", "preparing", "running", "disambiguating"].includes(run.status)));
    const disambiguatingRuns = $derived(runs.filter((run) => run.status === "disambiguating"));
    const completedRuns = $derived(runs.filter((run) => run.status === "completed" && run.terminal_outcome?.severity !== "warn"));
    const suspectRuns = $derived(runs.filter((run) => run.terminal_outcome?.severity === "warn"));
    const blockedRuns = $derived(runs.filter((run) => run.status === "blocked"));
    const failedRuns = $derived(runs.filter((run) => run.status === "error" && run.terminal_outcome?.severity !== "warn"));
    const syncTone = $derived(s.syncStatus === "fresh"
        ? "healthy"
        : s.syncStatus === "syncing"
            ? "info"
            : s.syncStatus === "stale"
                ? "danger"
                : "warn");
    const syncLabel = $derived(s.syncStatus === "syncing"
        ? "synchronizing"
        : s.syncStatus === "stale"
            ? s.lastSuccessfulSyncAt
                ? `sync failed · last synced at ${actions.formatSyncTime(s.lastSuccessfulSyncAt)}`
                : "sync failed"
            : s.lastSuccessfulSyncAt
                ? `synced at ${actions.formatSyncTime(s.lastSuccessfulSyncAt)}`
                : "not yet synced");
    const dispatchNodes = $derived(preview?.groups?.flatMap((group) => group.nodes.map((node) => ({
        ...node,
        group_id: group.group_id,
        repo: group.repo,
        merge_order: group.merge_order || [],
    }))) || []);
    const selectedRun = $derived(s.selectedRunId ? runs.find((r) => r.run_id === s.selectedRunId) ?? null : null);
    const selectedDispatch = $derived(s.selectedDispatchId ? dispatchNodes.find((n) => n.id === s.selectedDispatchId) ?? null : null);
    const selectedPullRequest = $derived(selectedRun ? selectedRun.pull_request || s.prResults[selectedRun.run_id] || null : null);
    const selectedRecoveryData = $derived(selectedRun ? s.recoveryByWorkItem[selectedRun.work_item_id] || {} : {});
    const selectedRecovery = $derived(projectExecutionRecovery({
        run: s.activeSelection === "run" ? selectedRun : null,
        workItem: selectedRecoveryData.workItem,
        eligibility: selectedRecoveryData.eligibility,
        reconciled: selectedRun ? reconciledByWorkItem[selectedRun.work_item_id] : null,
        loading: !!selectedRecoveryData.loading,
        lookupError: selectedRecoveryData.lookupError,
        actionInFlight: !!selectedRecoveryData.actionInFlight,
        actionError: selectedRecoveryData.actionError,
    }));
    const selectedRunTurnGroups = $derived(selectedRun ? actions.groupByTurn(selectedRun.activity_log) : []);
    Object.assign(actions, createRunData(s, actions));
    Object.assign(actions, createRunActions(s, actions));
    Object.assign(actions, createRefinementActions(s, actions));
    Object.assign(actions, createActivity(s, actions));
    s.refinementResponses = actions.loadRefinementDrafts();
    $effect(() => { const run = s.activeSelection === 'run' ? s.selectedRun : null; const key = run?.status === 'error' ? run.run_id + ':' + run.work_item_id : null; untrack(() => { if (key !== s.recoveryLookupKey) {
        s.recoveryLookupKey = key;
        if (key)
            actions.refreshRecovery(run).catch(() => { });
    } }); });
    $effect(() => { const runs = s.runs; const nodes = s.dispatchNodes; const selectedRunId = s.selectedRunId; untrack(() => { if (!selectedRunId && runs.length) {
        s.selectedRunId = (runs.find(r => ['disambiguating', 'running', 'preparing', 'queued'].includes(r.status)) || runs[0]).run_id;
        s.activeSelection = 'run';
    } if (!s.selectedDispatchId && nodes.length)
        s.selectedDispatchId = nodes[0].id; }); });
    $effect(() => { const count = s.selectedRun?.activity_log?.length ?? 0; const el = s.feedScrollEl; untrack(() => { if (el && count > s.prevActivityCount)
        el.scrollTop = el.scrollHeight; s.prevActivityCount = count; }); });
    onMount(() => {
        let firstReload = true;
        s.syncCoordinator = createExecutionSyncCoordinator({
            reload: () => {
                const quiet = !firstReload;
                firstReload = false;
                return actions.loadData({ quiet });
            },
            onStateChange: (state) => {
                s.syncStatus = state.status;
                s.lastSuccessfulSyncAt = state.lastSuccessfulSyncAt;
                s.syncError = state.error;
            },
        });
        const requestVisibleSync = () => {
            if (document.visibilityState === "visible")
                actions.requestDataSync();
        };
        const handleStreamOpen = () => {
            s.connected = true;
            actions.requestDataSync();
        };
        const handleStreamError = () => { s.connected = false; };
        actions.requestDataSync();
        document.addEventListener("visibilitychange", requestVisibleSync);
        window.addEventListener("focus", requestVisibleSync);
        s.stream = new EventSource("/api/execution/stream");
        s.stream.addEventListener("open", handleStreamOpen);
        s.stream.addEventListener("error", handleStreamError);
        const handleEnvelope = (event) => {
            try {
                const envelope = JSON.parse(event.data);
                const run = envelope.payload?.run;
                actions.mergeRun(run);
                if (run && ["running", "disambiguating"].includes(run.status) && !s.checklistData[run.run_id]) {
                    actions.loadChecklist(run.run_id);
                }
            }
            catch (e) {
                console.error("Failed to parse execution SSE event", e);
            }
        };
        const handleChecklistEvent = (event) => {
            try {
                const envelope = JSON.parse(event.data);
                const snapshot = envelope.payload;
                const runId = envelope.session_id;
                if (shouldReplaceChecklistSnapshot(s.checklistData[runId], snapshot, runId)) {
                    s.checklistData = { ...s.checklistData, [runId]: snapshot };
                }
            }
            catch (e) {
                console.error("Failed to parse checklist SSE event", e);
            }
        };
        s.stream.addEventListener("execution_status", handleEnvelope);
        s.stream.addEventListener("execution_result", handleEnvelope);
        s.stream.addEventListener("execution_checklist", handleChecklistEvent);
        return () => {
            document.removeEventListener("visibilitychange", requestVisibleSync);
            window.removeEventListener("focus", requestVisibleSync);
            s.syncCoordinator?.dispose();
            s.syncCoordinator = null;
            window.clearTimeout(s.copyTimer);
            s.refinementDrawerResizeCleanup?.();
            s.stream?.close();
        };
    });
    /**
     * Apply UI state changes from view components. Writing through the owning
     * module (rather than mutating the `workspace` prop) keeps Svelte's prop
     * ownership rules intact.
     * @param {Partial<typeof s>} patch
     */
    function assign(patch) { Object.assign(s, patch); }
    /** Attachment that registers the activity feed's scroll container. @param {HTMLElement} node */
    function attachFeedScroll(node) {
        s.feedScrollEl = node;
        return () => { if (s.feedScrollEl === node) s.feedScrollEl = null; };
    }
    return Object.assign(s, actions, { assign, attachFeedScroll });
}
