<script>

import GraphNodeContextMenu from "./GraphNodeContextMenu.svelte";

/** @type {ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace>} */
export let workspace;
</script>
{#if workspace.activeTab === "planning" && workspace.graphContextMenu.open && workspace.graphContextMenu.item && workspace.graphContextMenuModel}
      <GraphNodeContextMenu
        menu={workspace.graphContextMenuModel}
        x={workspace.graphContextMenu.x}
        y={workspace.graphContextMenu.y}
        on:action={(event) => {
          const item = workspace.graphContextMenu.item;
          if (event.detail.id === "launch-execution") {
            workspace.handleLaunchExecution(item);
          } else if (event.detail.id === "prepare-plan") {
            workspace.handlePreparePlan(item);
            workspace.closeGraphContextMenu();
          } else if (event.detail.id === "approve-plan") {
            workspace.handleApprovePlan(item);
            workspace.closeGraphContextMenu();
          } else if (event.detail.id === "review-plan") {
            workspace.handleReviewPlan(item, workspace.planStateById[item.id] ?? null);
            workspace.closeGraphContextMenu();
          } else if (event.detail.id === "cancel-work-item") {
            workspace.openCancelDialog(item);
          } else if (event.detail.id === "delete-work-item") {
            workspace.openDeleteDialog(item);
          }
        }}
        on:requestclose={workspace.closeGraphContextMenu}
      />
    {/if}

<style>
</style>
