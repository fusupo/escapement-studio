import { getExecutionPreview, getRunChecklist, getRunScratchpad, listArchivedExecutionRuns, listExecutionRuns, listReconciledWorkItems } from "../api.js";
import { shouldReplaceChecklistSnapshot } from "../checklist-sync.js";
/** run data for the execution workspace. */
export function createRunData(s, actions) {
    function enabledEventsFor(run) {
        if (!run)
            return [];
        return s.reconciledByWorkItem[run.work_item_id]?.enabled_events ?? [];
    }
    function canDisposeRun(run) {
        const events = actions.enabledEventsFor(run);
        return events.includes("user.finalize") || events.includes("user.archive_and_finalize");
    }
    function selectRun(runId) {
        s.selectedRunId = runId;
        s.activeSelection = "run";
    }
    function selectDispatch(id) {
        s.selectedDispatchId = id;
        s.activeSelection = "dispatch";
    }
    function mergeRun(run) {
        if (!run)
            return;
        const idx = s.runs.findIndex((item) => item.run_id === run.run_id);
        if (idx >= 0) {
            s.runs = s.runs.map((item, i) => (i === idx ? run : item));
        }
        else {
            s.runs = [run, ...s.runs].slice(0, 16);
        }
    }
    async function copyValue(value, message) {
        if (!value || !window?.navigator?.clipboard) {
            s.copiedMessage = "Clipboard unavailable.";
            return;
        }
        try {
            await window.navigator.clipboard.writeText(value);
            s.copiedMessage = message;
            window.clearTimeout(s.copyTimer);
            s.copyTimer = window.setTimeout(() => { s.copiedMessage = ""; }, 2000);
        }
        catch (e) {
            s.copiedMessage = e.message;
        }
    }
    async function loadData({ quiet = false } = {}) {
        if (quiet) {
            s.refreshing = true;
        }
        else {
            s.loading = true;
        }
        s.archivedLoading = true;
        s.error = "";
        s.archivedError = "";
        try {
            const [nextPreview, nextRuns, nextReconciled, nextArchivedBundles] = await Promise.all([
                getExecutionPreview(),
                listExecutionRuns(),
                // Reconciled view is best-effort — a failure here should not take
                // down the whole dispatch panel, so we fall back to an empty list.
                listReconciledWorkItems().catch((err) => {
                    console.debug("listReconciledWorkItems failed", err);
                    return [];
                }),
                listArchivedExecutionRuns().catch((err) => {
                    console.debug("listArchivedExecutionRuns failed", err);
                    s.archivedError = err.message;
                    return [];
                }),
            ]);
            s.preview = nextPreview;
            s.runs = nextRuns;
            s.archivedBundles = nextArchivedBundles;
            const nextMap = {};
            for (const entry of nextReconciled || []) {
                if (entry?.work_item_id)
                    nextMap[entry.work_item_id] = entry;
            }
            s.reconciledByWorkItem = nextMap;
            // Checklist recovery is part of the synchronization completion: refresh
            // every returned run, including cached and terminal entries, so a missed
            // SSE event converges before the coordinator reports fresh.
            await Promise.all(nextRuns.map((run) => actions.loadChecklist(run.run_id)));
        }
        catch (e) {
            s.error = e.message;
            throw e;
        }
        finally {
            s.loading = false;
            s.refreshing = false;
            s.archivedLoading = false;
        }
    }
    function requestDataSync() {
        return s.syncCoordinator?.requestSync() ?? actions.loadData({ quiet: true });
    }
    async function loadChecklist(runId) {
        try {
            const result = await getRunChecklist(runId);
            if (shouldReplaceChecklistSnapshot(s.checklistData[runId], result, runId)) {
                s.checklistData = { ...s.checklistData, [runId]: result };
            }
        }
        catch (e) {
            // A checklist endpoint failure is isolated to this run and must not
            // prevent the wider execution synchronization from becoming fresh.
            console.debug("Failed to load checklist", e);
        }
    }
    async function loadScratchpad(runId) {
        if (s.scratchpadContent[runId] !== undefined)
            return;
        s.scratchpadLoading = { ...s.scratchpadLoading, [runId]: true };
        try {
            const result = await getRunScratchpad(runId);
            s.scratchpadContent = { ...s.scratchpadContent, [runId]: result.content };
        }
        catch (e) {
            s.scratchpadContent = { ...s.scratchpadContent, [runId]: null };
        }
        finally {
            s.scratchpadLoading = { ...s.scratchpadLoading, [runId]: false };
        }
    }
    function formatSyncTime(value) {
        try {
            return value.toLocaleTimeString();
        }
        catch {
            return "";
        }
    }
    return { enabledEventsFor, canDisposeRun, selectRun, selectDispatch, mergeRun, copyValue, loadData, requestDataSync, loadChecklist, loadScratchpad, formatSyncTime };
}
