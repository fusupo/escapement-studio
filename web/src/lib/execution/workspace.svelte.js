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
    const s = $state({
        preview: null,
        runs: [],
        archivedBundles: [],
        archivedLoading: false,
        archivedError: "",
        reconciledByWorkItem: {},
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
        get activeRuns() { return s.runs.filter((run) => ["queued", "preparing", "running", "disambiguating"].includes(run.status)); },
        get disambiguatingRuns() { return s.runs.filter((run) => run.status === "disambiguating"); },
        get completedRuns() { return s.runs.filter((run) => run.status === "completed" && run.terminal_outcome?.severity !== "warn"); },
        get suspectRuns() { return s.runs.filter((run) => run.terminal_outcome?.severity === "warn"); },
        get blockedRuns() { return s.runs.filter((run) => run.status === "blocked"); },
        get failedRuns() { return s.runs.filter((run) => run.status === "error" && run.terminal_outcome?.severity !== "warn"); },
        get syncTone() {
            return s.syncStatus === "fresh"
                ? "healthy"
                : s.syncStatus === "syncing"
                    ? "info"
                    : s.syncStatus === "stale"
                        ? "danger"
                        : "warn";
        },
        get syncLabel() {
            return s.syncStatus === "syncing"
                ? "synchronizing"
                : s.syncStatus === "stale"
                    ? s.lastSuccessfulSyncAt
                        ? `sync failed · last synced at ${actions.formatSyncTime(s.lastSuccessfulSyncAt)}`
                        : "sync failed"
                    : s.lastSuccessfulSyncAt
                        ? `synced at ${actions.formatSyncTime(s.lastSuccessfulSyncAt)}`
                        : "not yet synced";
        },
        get dispatchNodes() {
            return s.preview?.groups?.flatMap((group) => group.nodes.map((node) => ({
                ...node,
                group_id: group.group_id,
                repo: group.repo,
                merge_order: group.merge_order || [],
            }))) || [];
        },
        get selectedRun() { return s.selectedRunId ? s.runs.find((r) => r.run_id === s.selectedRunId) ?? null : null; },
        get selectedDispatch() { return s.selectedDispatchId ? s.dispatchNodes.find((n) => n.id === s.selectedDispatchId) ?? null : null; },
        get selectedPullRequest() { return s.selectedRun ? s.selectedRun.pull_request || s.prResults[s.selectedRun.run_id] || null : null; },
        get selectedRecoveryData() { return s.selectedRun ? s.recoveryByWorkItem[s.selectedRun.work_item_id] || {} : {}; },
        get selectedRecovery() {
            return projectExecutionRecovery({
                run: s.activeSelection === "run" ? s.selectedRun : null,
                workItem: s.selectedRecoveryData.workItem,
                eligibility: s.selectedRecoveryData.eligibility,
                reconciled: s.selectedRun ? s.reconciledByWorkItem[s.selectedRun.work_item_id] : null,
                loading: !!s.selectedRecoveryData.loading,
                lookupError: s.selectedRecoveryData.lookupError,
                actionInFlight: !!s.selectedRecoveryData.actionInFlight,
                actionError: s.selectedRecoveryData.actionError,
            });
        },
        get selectedRunTurnGroups() { return s.selectedRun ? actions.groupByTurn(s.selectedRun.activity_log) : []; }
    });
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
    return Object.assign(s, actions);
}
