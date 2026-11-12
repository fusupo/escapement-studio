/** pane interactions for the planning workspace. */
export function createPaneInteractions(s, actions) {
    function onDragStart(pane, event) {
        s.dragging = pane;
        s.dragStartX = event.clientX;
        s.dragStartWidth = pane === "left" ? s.chatWidth : s.sidebarWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", actions.onDragMove);
        window.addEventListener("mouseup", actions.onDragEnd);
    }
    function onDragMove(event) {
        if (!s.dragging)
            return;
        const delta = event.clientX - s.dragStartX;
        if (s.dragging === "left") {
            s.chatWidth = Math.min(s.MAX_PANE, Math.max(s.MIN_PANE, s.dragStartWidth + delta));
        }
        else {
            s.sidebarWidth = Math.min(s.MAX_PANE, Math.max(s.MIN_PANE, s.dragStartWidth - delta));
        }
    }
    function onDragEnd() {
        s.dragging = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", actions.onDragMove);
        window.removeEventListener("mouseup", actions.onDragEnd);
    }
    function handleGraphSelect(item) {
        s.selectedId = item?.id ?? null;
        actions.closeGraphContextMenu();
    }
    async function handleGraphContextMenu(detail) {
        if (!detail?.item?.id) {
            actions.closeGraphContextMenu();
            return;
        }
        s.selectedId = detail.item.id;
        s.graphContextMenu = {
            open: true,
            x: detail.x,
            y: detail.y,
            item: detail.item,
        };
        await actions.ensureLaunchEligibility(detail.item.id);
        // Also prime plan state for issue kinds so the context menu can gate
        // Prepare / Approve / Review correctly. Non-issue kinds skip the fetch.
        if (detail.item.kind === "issue"
            && ["drafting", "ready", "in_progress", "open_pr", "merged_pr", "planned"].includes(actions.leafState(detail.item.state))) {
            await actions.ensurePlanState(detail.item.id);
        }
    }
    function handleGlobalKeydown(event) {
        if (event.key === "Escape") {
            actions.closeGraphContextMenu();
            if (s.planReview) {
                actions.closePlanReview();
            }
            if (s.cancelDialog) {
                actions.closeCancelDialog();
            }
            if (s.deleteDialog) {
                actions.closeDeleteDialog();
            }
        }
    }
    function onResizeKeydown(pane, event) {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const key = pane === "left" ? "chatWidth" : "sidebarWidth";
        const direction = (event.key === "ArrowRight" ? 1 : -1) * (pane === "left" ? 1 : -1);
        s[key] = Math.min(s.MAX_PANE, Math.max(s.MIN_PANE, s[key] + direction * 24));
    }
    return { onResizeKeydown, onDragStart, onDragMove, onDragEnd, handleGraphSelect, handleGraphContextMenu, handleGlobalKeydown };
}
