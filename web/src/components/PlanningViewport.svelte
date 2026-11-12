<script>
import PlannerChatAdapter from "./PlannerChatAdapter.svelte";

import GraphView from "./GraphView.svelte";

import FiltersToolbar from "./FiltersToolbar.svelte";
import Sidebar from "./Sidebar.svelte";

/** @type {{ workspace: ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace> }} */
let { workspace } = $props();
</script>
<div class="planning-viewport">
        <!-- Filter bar -->
        <div class="filter-bar">
          <FiltersToolbar filters={workspace.filters} options={workspace.filterOptions} onChange={workspace.handleFilterChange} onReset={workspace.resetFilters} />
        </div>

        <!-- 3-column resizable layout -->
        <div class="planning-columns" class:dragging={workspace.dragging !== null}>
          <!-- Left: Chat -->
          {#if !workspace.chatCollapsed}
            <div class="col-pane col-chat" style="width:{workspace.chatWidth}px; min-width:{workspace.chatWidth}px; max-width:{workspace.chatWidth}px;">
              <div class="pane-header">
                <span class="pane-title">CHAT</span>
                <div class="pane-actions">
                  <button class="pane-action" onclick={() => workspace.assign({ chatCollapsed: true })} title="Collapse panel" aria-label="Collapse chat panel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11,17 6,12 11,7"/><polyline points="18,17 13,12 18,7"/></svg>
                  </button>
                </div>
              </div>
              <div class="pane-body">
                <PlannerChatAdapter on:graphChanged={workspace.refresh} />
              </div>
            </div>
            <!-- Left resize handle -->
            <button class="resize-handle" onmousedown={(e) => workspace.onDragStart("left", e)} onkeydown={(e) => workspace.onResizeKeydown("left", e)} aria-label="Resize chat panel"></button>
          {:else}
            <button class="collapsed-pane-tab" onclick={() => workspace.assign({ chatCollapsed: false })} title="Expand Chat">
              <span>CHAT</span>
            </button>
          {/if}

          <!-- Center: Graph -->
          <div class="col-pane col-graph">
            <div class="pane-header">
              <span class="pane-title">GRAPH</span>
              <span class="pane-badge">{workspace.graph.items.length} items · {workspace.graph.edges.length} edges</span>
            </div>
            <div class="pane-body pane-body-graph">
              {#if workspace.error}
                <div class="banner error">{workspace.error}</div>
              {/if}
              {#if workspace.notice}
                <div class="banner info">{workspace.notice}</div>
              {/if}
              {#if workspace.loading}
                <div class="empty-state">Loading graph…</div>
              {:else}
                <GraphView
                  graph={workspace.graph}
                  selectedId={workspace.selectedId}
                  onSelect={workspace.handleGraphSelect}
                  onContextMenu={workspace.handleGraphContextMenu}
                  externalFrontierIds={workspace.frontierIds}
                />
              {/if}
            </div>
          </div>

          <!-- Right resize handle -->
          {#if !workspace.sidebarCollapsed}
            <button class="resize-handle" onmousedown={(e) => workspace.onDragStart("right", e)} onkeydown={(e) => workspace.onResizeKeydown("right", e)} aria-label="Resize details panel"></button>
          {/if}

          <!-- Right: Detail sidebar -->
          {#if !workspace.sidebarCollapsed}
            <div class="col-pane col-sidebar" style="width:{workspace.sidebarWidth}px; min-width:{workspace.sidebarWidth}px; max-width:{workspace.sidebarWidth}px;">
              <div class="pane-header">
                <span class="pane-title">DETAILS</span>
                <div class="pane-actions">
                  <button class="pane-action" onclick={() => workspace.assign({ sidebarCollapsed: true })} title="Collapse panel" aria-label="Collapse details panel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13,17 18,12 13,7"/><polyline points="6,17 11,12 6,7"/></svg>
                  </button>
                </div>
              </div>
              <div class="pane-body">
                <Sidebar
                  selectedItem={workspace.selectedItem}
                  launchEligibility={workspace.selectedLaunchEligibility}
                  launchEligibilityLoading={workspace.selectedLaunchEligibilityLoading}
                  launchingExecution={workspace.launchingExecution}
                  onLaunchExecution={workspace.handleLaunchExecution}
                  onPreparePlan={workspace.handlePreparePlan}
                  onApprovePlan={workspace.handleApprovePlan}
                  onReviewPlan={workspace.handleReviewPlan}
                  preparingPlan={workspace.preparingPlan}
                  approvingPlan={workspace.approvingPlan}
                  graph={workspace.graph}
                  saving={workspace.saving}
                  edgeSaving={workspace.edgeSaving}
                  onSaveItem={workspace.handleSaveItem}
                  onCreateItem={workspace.handleCreateItem}
                  onCreateEdge={workspace.handleCreateEdge}
                  onDeleteEdge={workspace.handleDeleteEdge}
                  onCloseIssue={workspace.handleCloseIssue}
                  onArchiveWorkItem={workspace.handleArchiveWorkItem}
                  onCancelWorkItem={workspace.openCancelDialog}
                  onDeleteWorkItem={workspace.openDeleteDialog}
                  closingIssue={workspace.closingIssue}
                  archivingWorkItem={workspace.archivingWorkItem}
                  cancelingWorkItem={workspace.cancelingWorkItem}
                  deletingWorkItem={workspace.deletingWorkItem}
                />
              </div>
            </div>
          {:else}
            <button class="collapsed-pane-tab collapsed-pane-tab-right" onclick={() => workspace.assign({ sidebarCollapsed: false })} title="Expand Details">
              <span>DETAILS</span>
            </button>
          {/if}
        </div>
      </div>

<style>
  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    min-height: 28px;
    padding: 0 10px;
    background: #13171f;
    border-bottom: 1px solid #2b3245;
    flex-shrink: 0;
  }

  .pane-title {
    font-size: 10.5px;
    font-weight: 700;
    color: #8b95a5;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .pane-badge {
    font-size: 10.5px;
    color: #566070;
    letter-spacing: 0.01em;
  }

  .pane-actions {
    display: flex;
    gap: 2px;
  }

  .pane-action {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    color: #6b7a94;
    border-radius: 3px;
    transition: background 80ms, color 80ms;
  }

  .pane-action:hover {
    background: rgba(255,255,255,0.08);
    color: #c5cdd8;
  }
  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  .pane-body-graph {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }
  .collapsed-pane-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    writing-mode: vertical-lr;
    width: 28px;
    padding: 10px 0;
    background: #13171f;
    color: #6b7a94;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border-radius: 0;
    border-right: 1px solid #2b3245;
    transition: background 80ms, color 80ms;
  }

  .collapsed-pane-tab:hover {
    background: #1a2030;
    color: #c5cdd8;
  }

  .collapsed-pane-tab-right {
    border-right: none;
    border-left: 1px solid #2b3245;
  }
  .resize-handle {
    padding: 0;
    border: 0;
    border-radius: 0;
    width: 4px;
    cursor: col-resize;
    background: transparent;
    transition: background 120ms;
    flex-shrink: 0;
    position: relative;
    z-index: 5;
  }

  .resize-handle:hover,
  .dragging .resize-handle {
    background: #2563eb;
  }
  .planning-viewport {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .filter-bar {
    padding: 4px 8px;
    border-bottom: 1px solid #2b3245;
    background: #13171f;
    flex-shrink: 0;
  }

  .planning-columns {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .col-pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .col-graph {
    flex: 1;
    min-width: 0;
  }

  .col-chat,
  .col-sidebar {
    flex-shrink: 0;
  }

  .col-chat {
    border-right: 1px solid #2b3245;
  }

  .col-sidebar {
    border-left: 1px solid #2b3245;
  }
  .empty-state {
    display: grid;
    place-items: center;
    flex: 1;
    color: #6b7a94;
    font-size: 12px;
  }

  .banner.info {
    background: rgba(37, 99, 235, 0.14);
    border: 1px solid rgba(96, 165, 250, 0.28);
    color: #dbeafe;
  }
  @media (max-width: 860px) {

    .planning-columns {
      flex-direction: column;
      overflow-y: auto;
    }

    .col-graph { flex: none; overflow: visible; }
    .col-chat { height: 300px; }
    .col-sidebar { overflow: visible; }
    .col-sidebar .pane-body { overflow: visible; }

    .col-chat,
    .col-sidebar {
      width: 100% !important;
      min-width: 100% !important;
      max-width: 100% !important;
      border: none;
      border-bottom: 1px solid #2b3245;
    }

    .resize-handle {
    padding: 0;
    border: 0;
    border-radius: 0;
      display: none;
    }

    .collapsed-pane-tab {
      writing-mode: horizontal-tb;
      width: 100%;
      height: 28px;
    }
  }
</style>
