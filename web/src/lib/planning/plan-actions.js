import { approvePlan, launchExecutionRun, preparePlan } from "../api.js";
/** plan actions for the planning workspace. */
export function createPlanActions(s, actions) {
    async function handlePreparePlan(item = s.selectedItem) {
        const workItemId = item?.id;
        if (!workItemId)
            return;
        s.preparingPlan = true;
        s.error = "";
        try {
            await preparePlan(workItemId);
            // Refresh plan cache + graph so the work item state reflects the
            // `planned → drafting` transition that prepare triggers.
            await actions.ensurePlanState(workItemId, { force: true });
            await actions.loadGraph();
        }
        catch (prepareError) {
            s.error = prepareError.message;
        }
        finally {
            s.preparingPlan = false;
        }
    }
    async function handleApprovePlan(item = s.selectedItem) {
        const workItemId = item?.id;
        if (!workItemId)
            return;
        s.approvingPlan = true;
        s.error = "";
        try {
            await approvePlan(workItemId, {});
            // Approve transitions plan drafting → ready AND work item to ready.
            await actions.ensurePlanState(workItemId, { force: true });
            await actions.loadGraph();
        }
        catch (approveError) {
            s.error = approveError.message;
        }
        finally {
            s.approvingPlan = false;
        }
    }
    async function handleReviewPlan(item = s.selectedItem, cachedPlan = null) {
        const workItemId = item?.id;
        if (!workItemId)
            return;
        s.error = "";
        try {
            // Prefer the cached plan passed in from the Sidebar/context menu; fall
            // back to a fresh fetch if we don't have one yet.
            const plan = cachedPlan ?? s.planStateById[workItemId] ?? await actions.ensurePlanState(workItemId, { force: true });
            if (!plan) {
                s.error = `No plan to review for ${workItemId}. Try Prepare plan first.`;
                return;
            }
            s.planReview = {
                workItemId,
                scratchpadContent: plan.scratchpad_content ?? "",
                planState: plan.metadata?.state ?? null,
            };
        }
        catch (reviewError) {
            s.error = reviewError.message;
        }
    }
    function closePlanReview() {
        s.planReview = null;
    }
    async function handleLaunchExecution(item = s.selectedItem) {
        const workItemId = item?.id;
        if (!workItemId)
            return;
        s.launchingExecution = true;
        s.error = "";
        try {
            const itemLeafState = actions.leafState(item?.state);
            // ADR 014 step 8 — stricter UI gate than the backend: require work
            // item state to be `ready` so users can't skip plan approval via the
            // UI, even though the backend still accepts `planned` as a
            // transitional fallback.
            if (itemLeafState !== "ready") {
                s.error = `Approve the plan first — work item state is ${item?.state ?? "unknown"}, expected ready.`;
                return;
            }
            const eligibility = await actions.ensureLaunchEligibility(workItemId, { force: true });
            if (!eligibility?.issue_backed) {
                s.error = "Launch execution is only available for issue-backed work items.";
                return;
            }
            if (!eligibility?.can_launch) {
                s.error = eligibility?.launch_unavailable_reason || "Launch execution is not available for this node.";
                return;
            }
            const result = await launchExecutionRun({ work_item_id: workItemId, disambiguate: true });
            await actions.ensureLaunchEligibility(workItemId, { force: true });
            actions.closeGraphContextMenu();
            if (result?.run) {
                s.activeTab = "execute";
            }
        }
        catch (launchError) {
            s.error = launchError.message;
        }
        finally {
            s.launchingExecution = false;
        }
    }
    return { handlePreparePlan, handleApprovePlan, handleReviewPlan, closePlanReview, handleLaunchExecution };
}
