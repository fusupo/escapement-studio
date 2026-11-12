import { archiveAndCloseMergedPullRequest, cancelWorkItem, closeMergedPullRequest, createEdge, createWorkItem, deleteEdge, deleteWorkItem, updateWorkItem } from "../api.js";
/** work item actions for the planning workspace. */
export function createWorkItemActions(s, actions) {
    async function handleSaveItem(payload) {
        if (!s.selectedItem)
            return;
        s.saving = true;
        s.error = "";
        try {
            await updateWorkItem(s.selectedItem.id, payload);
            await actions.loadGraph();
        }
        catch (saveError) {
            s.error = saveError.message;
        }
        finally {
            s.saving = false;
        }
    }
    async function handleCreateItem(payload) {
        s.saving = true;
        s.error = "";
        try {
            const created = await createWorkItem(payload);
            s.selectedId = created.id;
            await actions.loadGraph();
        }
        catch (saveError) {
            s.error = saveError.message;
        }
        finally {
            s.saving = false;
        }
    }
    async function handleCreateEdge(payload) {
        s.edgeSaving = true;
        s.error = "";
        try {
            await createEdge(payload);
            await actions.loadGraph();
        }
        catch (edgeError) {
            s.error = edgeError.message;
        }
        finally {
            s.edgeSaving = false;
        }
    }
    async function handleDeleteEdge(id) {
        s.edgeSaving = true;
        s.error = "";
        try {
            await deleteEdge(id);
            await actions.loadGraph();
        }
        catch (edgeError) {
            s.error = edgeError.message;
        }
        finally {
            s.edgeSaving = false;
        }
    }
    async function handleCloseIssue(item) {
        if (!item?.id)
            return;
        s.closingIssue = true;
        s.error = "";
        s.notice = "";
        try {
            // studio-87: the backend owns the full close orchestration
            // (gh issue close → merged_pr → done transition → dispose matching
            // recent runs). The sidebar's `canCloseIssue` guard (merged PR +
            // open issue) is the only precondition the frontend enforces.
            await closeMergedPullRequest(item.id);
            await actions.loadGraph();
        }
        catch (closeError) {
            s.error = closeError.message;
        }
        finally {
            s.closingIssue = false;
        }
    }
    async function handleArchiveWorkItem(item) {
        if (!item?.id)
            return;
        s.archivingWorkItem = true;
        s.error = "";
        s.notice = "";
        try {
            const result = await archiveAndCloseMergedPullRequest(item.id);
            await actions.loadGraph();
            s.notice = `Archived ${item.id} to ${result.archive.archive_path}.`;
        }
        catch (archiveError) {
            s.error = archiveError.message;
        }
        finally {
            s.archivingWorkItem = false;
        }
    }
    function openCancelDialog(item = s.selectedItem) {
        if (!item?.id)
            return;
        s.cancelDialog = {
            item,
            confirmCancel: false,
            cancelNote: "",
            submitting: false,
        };
        actions.closeGraphContextMenu();
    }
    function closeCancelDialog() {
        if (s.cancelDialog?.submitting)
            return;
        s.cancelDialog = null;
    }
    async function confirmCancelWorkItem() {
        if (!s.cancelDialog?.item?.id || s.cancelDialog.submitting)
            return;
        s.cancelDialog = { ...s.cancelDialog, submitting: true };
        s.cancelingWorkItem = true;
        s.error = "";
        s.notice = "";
        try {
            const result = await cancelWorkItem({
                work_item_id: s.cancelDialog.item.id,
                confirm_cancel: true,
                cancel_note: s.cancelDialog.cancelNote?.trim() || undefined,
            });
            await actions.loadGraph();
            s.notice = `Cancelled ${result.work_item.id} and closed issue #${result.closed_issue.number}.`;
            s.cancelDialog = null;
        }
        catch (cancelError) {
            s.error = cancelError.message;
            s.cancelDialog = { ...s.cancelDialog, submitting: false };
        }
        finally {
            s.cancelingWorkItem = false;
        }
    }
    function openDeleteDialog(item = s.selectedItem) {
        if (!item?.id)
            return;
        const connectedEdges = s.graph.edges.filter((edge) => edge.from_id === item.id || edge.to_id === item.id);
        s.deleteDialog = {
            item,
            connectedEdges,
            acknowledgeDelete: false,
            acknowledgeConnectedEdges: connectedEdges.length === 0,
            acknowledgeFallback: false,
            warnings: [],
            submitting: false,
        };
        actions.closeGraphContextMenu();
    }
    function closeDeleteDialog() {
        if (s.deleteDialog?.submitting)
            return;
        s.deleteDialog = null;
    }
    async function confirmDeleteWorkItem() {
        if (!s.deleteDialog?.item?.id || s.deleteDialog.submitting)
            return;
        s.deleteDialog = { ...s.deleteDialog, submitting: true };
        s.deletingWorkItem = true;
        s.error = "";
        s.notice = "";
        try {
            const result = await deleteWorkItem({
                work_item_id: s.deleteDialog.item.id,
                confirm_delete: true,
                acknowledge_connected_edges: s.deleteDialog.acknowledgeConnectedEdges,
                allow_graph_delete_without_github: s.deleteDialog.acknowledgeFallback,
            });
            await actions.loadGraph();
            s.selectedId = s.selectedId === s.deleteDialog.item.id ? null : s.selectedId;
            s.notice = result.warnings?.length > 0
                ? result.warnings.join(" ")
                : `Deleted ${s.deleteDialog.item.id}.`;
            s.deleteDialog = null;
        }
        catch (deleteError) {
            s.error = deleteError.message;
            s.deleteDialog = { ...s.deleteDialog, submitting: false };
        }
        finally {
            s.deletingWorkItem = false;
        }
    }
    return { handleSaveItem, handleCreateItem, handleCreateEdge, handleDeleteEdge, handleCloseIssue, handleArchiveWorkItem, openCancelDialog, closeCancelDialog, confirmCancelWorkItem, openDeleteDialog, closeDeleteDialog, confirmDeleteWorkItem };
}
