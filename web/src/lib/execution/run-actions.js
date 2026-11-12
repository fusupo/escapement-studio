import { fastForwardExecutionBase, archiveAndCloseMergedPullRequest, cleanupExecutionWorktree, closeMergedPullRequest, getExecutionEligibility, getWorkItem, launchExecutionRun, openPullRequest, transitionWorkItem } from "../api.js";
import { projectExecutionRecovery } from "../execution-recovery.js";
/** run actions for the execution workspace. */
export function createRunActions(s, actions) {
    async function handleFastForward(node) {
        const id = node?.id;
        if (!id || s.fastForwardPending[id]) return;
        s.fastForwardPending = { ...s.fastForwardPending, [id]: true };
        s.fastForwardErrors = { ...s.fastForwardErrors, [id]: "" };
        try {
            await fastForwardExecutionBase(id);
            await actions.requestDataSync();
        }
        catch (error) {
            const message = error.message || "Connection lost.";
            s.fastForwardErrors = { ...s.fastForwardErrors, [id]: message.startsWith("base_ref_sync_")
                ? message
                : `Fast-forward outcome unknown. Wait for synchronization before trying again. ${message}` };
        }
        finally {
            s.fastForwardPending = { ...s.fastForwardPending, [id]: false };
        }
    }
    function updateRecovery(workItemId, patch) {
        s.recoveryByWorkItem = {
            ...s.recoveryByWorkItem,
            [workItemId]: { ...(s.recoveryByWorkItem[workItemId] || {}), ...patch },
        };
    }
    async function refreshRecovery(run) {
        const workItemId = run.work_item_id;
        const token = (s.recoveryRequestTokens[workItemId] || 0) + 1;
        s.recoveryRequestTokens = { ...s.recoveryRequestTokens, [workItemId]: token };
        actions.updateRecovery(workItemId, { loading: true, lookupError: "" });
        try {
            const [workItem, eligibility] = await Promise.all([
                getWorkItem(workItemId),
                getExecutionEligibility({ work_item_id: workItemId }),
            ]);
            if (s.recoveryRequestTokens[workItemId] === token) {
                actions.updateRecovery(workItemId, { workItem, eligibility, loading: false, lookupError: "" });
            }
            return { workItem, eligibility };
        }
        catch (recoveryError) {
            if (s.recoveryRequestTokens[workItemId] === token) {
                actions.updateRecovery(workItemId, { loading: false, lookupError: recoveryError.message });
            }
            throw recoveryError;
        }
    }
    async function handleRedispatch(run) {
        const workItemId = run?.work_item_id;
        const currentData = workItemId ? s.recoveryByWorkItem[workItemId] || {} : {};
        const currentRecovery = projectExecutionRecovery({
            run,
            workItem: currentData.workItem,
            eligibility: currentData.eligibility,
            reconciled: s.reconciledByWorkItem[workItemId],
            loading: !!currentData.loading,
            lookupError: currentData.lookupError,
            actionInFlight: !!currentData.actionInFlight,
            actionError: currentData.actionError,
        });
        if (!workItemId || !currentRecovery.canRedispatch || currentData.actionInFlight)
            return;
        actions.updateRecovery(workItemId, { actionInFlight: true, actionError: "" });
        s.error = "";
        try {
            if (currentRecovery.shouldCleanupWorktree) {
                await cleanupExecutionWorktree(run.run_id);
            }
            if (currentRecovery.canInvestigate) {
                await transitionWorkItem(workItemId, "user.investigate");
            }
            const fresh = await actions.refreshRecovery(run);
            const directRecovery = projectExecutionRecovery({
                run,
                workItem: fresh.workItem,
                eligibility: fresh.eligibility,
            });
            if (!directRecovery.canRedispatch) {
                throw new Error(directRecovery.reason);
            }
            const result = await launchExecutionRun({ work_item_id: workItemId, disambiguate: true });
            actions.mergeRun(result.run);
            if (result.run) {
                s.selectedRunId = result.run.run_id;
                s.activeSelection = "run";
            }
            await actions.requestDataSync();
        }
        catch (recoveryError) {
            s.error = recoveryError.message;
            actions.updateRecovery(workItemId, { actionError: recoveryError.message });
        }
        finally {
            actions.updateRecovery(workItemId, { actionInFlight: false });
        }
    }
    async function handleOpenPR(run) {
        s.openingPrRunIds = [...s.openingPrRunIds, run.run_id];
        s.error = "";
        try {
            const result = await openPullRequest({ run_id: run.run_id, auto_commit: true });
            actions.mergeRun(result.run);
            s.prResults = { ...s.prResults, [run.run_id]: result.pull_request };
            await actions.requestDataSync();
        }
        catch (e) {
            s.error = e.message;
        }
        finally {
            s.openingPrRunIds = s.openingPrRunIds.filter((id) => id !== run.run_id);
        }
    }
    function dispositionHintFor(message) {
        if (!message)
            return "";
        // The backend guard (execution.service.ts assertNoActiveRunForWorkItem)
        // prefixes with this code; surface a compact inline hint for it.
        if (message.includes("cannot_dispose_work_item_active_run")) {
            return "Blocked: another run for this work item is still active. Wait for it to finish, then retry.";
        }
        return message;
    }
    async function handleCloseRun(run) {
        if (!run || s.disposingRunIds.includes(run.run_id))
            return;
        s.disposingRunIds = [...s.disposingRunIds, run.run_id];
        s.error = "";
        s.dispositionErrors = { ...s.dispositionErrors, [run.run_id]: "" };
        try {
            await closeMergedPullRequest(run.work_item_id);
            s.runs = s.runs.filter((r) => r.run_id !== run.run_id);
            if (s.selectedRunId === run.run_id)
                s.selectedRunId = null;
            s.dispositionErrors = { ...s.dispositionErrors, [run.run_id]: "" };
            await actions.requestDataSync();
        }
        catch (e) {
            s.error = e.message;
            s.dispositionErrors = { ...s.dispositionErrors, [run.run_id]: actions.dispositionHintFor(e.message) };
        }
        finally {
            s.disposingRunIds = s.disposingRunIds.filter((id) => id !== run.run_id);
        }
    }
    async function handleArchiveAndCloseRun(run) {
        if (!run || s.disposingRunIds.includes(run.run_id))
            return;
        s.disposingRunIds = [...s.disposingRunIds, run.run_id];
        s.error = "";
        s.dispositionErrors = { ...s.dispositionErrors, [run.run_id]: "" };
        try {
            await archiveAndCloseMergedPullRequest(run.work_item_id);
            s.runs = s.runs.filter((r) => r.run_id !== run.run_id);
            if (s.selectedRunId === run.run_id)
                s.selectedRunId = null;
            s.dispositionErrors = { ...s.dispositionErrors, [run.run_id]: "" };
            await actions.requestDataSync();
        }
        catch (e) {
            s.error = e.message;
            s.dispositionErrors = { ...s.dispositionErrors, [run.run_id]: actions.dispositionHintFor(e.message) };
        }
        finally {
            s.disposingRunIds = s.disposingRunIds.filter((id) => id !== run.run_id);
        }
    }
    async function launchNode(node) {
        s.launchingIds = [...s.launchingIds, node.id];
        s.error = "";
        try {
            const result = await launchExecutionRun({ work_item_id: node.id });
            actions.mergeRun(result.run);
            if (result.run) {
                s.selectedRunId = result.run.run_id;
                s.activeSelection = "run";
            }
            await actions.requestDataSync();
        }
        catch (e) {
            s.error = e.message;
        }
        finally {
            s.launchingIds = s.launchingIds.filter((id) => id !== node.id);
        }
    }
    function launchNodeById(id) {
        const node = s.dispatchNodes.find((n) => n.id === id);
        if (node)
            actions.launchNode(node);
    }
    return { handleFastForward, updateRecovery, refreshRecovery, handleRedispatch, handleOpenPR, dispositionHintFor, handleCloseRun, handleArchiveAndCloseRun, launchNode, launchNodeById };
}
