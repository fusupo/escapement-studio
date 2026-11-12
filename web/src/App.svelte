<script>

import ExecutionDispatchPanel from "./components/ExecutionDispatchPanel.svelte";
import ReconciliationPanel from "./components/ReconciliationPanel.svelte";
import SettingsPanel from "./components/SettingsPanel.svelte";

import { createWorkspace } from './lib/planning/workspace.svelte.js';
const workspace = createWorkspace();

import ActivityBar from './components/ActivityBar.svelte';
import PlanningViewport from './components/PlanningViewport.svelte';
import GraphActionsMenu from './components/GraphActionsMenu.svelte';
import PlanReviewDialog from './components/PlanReviewDialog.svelte';
import WorkItemDispositionDialogs from './components/WorkItemDispositionDialogs.svelte';
import WorkspaceStatusBar from './components/WorkspaceStatusBar.svelte';
</script>
<svelte:head>
  <title>Escapement Studio</title>
</svelte:head>

<svelte:window
  on:click={workspace.closeGraphContextMenu}
  on:contextmenu={workspace.closeGraphContextMenu}
  on:keydown={workspace.handleGlobalKeydown}
  on:resize={workspace.closeGraphContextMenu}
  on:scroll={workspace.closeGraphContextMenu}
/>

<div class="app-shell">
  <!-- Activity Bar (far left icon rail) -->
  <ActivityBar {workspace} />

  <!-- Main content area -->
  <div class="main-area">
    <!-- Title bar -->
    <header class="title-bar">
      <span class="title-bar-label">{workspace.activityItems.find(t => t.id === workspace.activeTab)?.label ?? ""}</span>
      <span class="title-bar-brand">Escapement Studio</span>
      <span class="title-bar-spacer"></span>
    </header>

    <!-- Planning tab -->
    {#if workspace.activeTab === "planning"}
      <PlanningViewport {workspace} />
    {:else if workspace.activeTab === "execute"}
      <div class="fullpane-viewport">
        <div class="pane-header">
          <span class="pane-title">EXECUTION</span>
        </div>
        <div class="pane-body fullpane-body">
          <ExecutionDispatchPanel />
        </div>
      </div>
    {:else if workspace.activeTab === "reconciliation"}
      <div class="fullpane-viewport">
        <div class="pane-header">
          <span class="pane-title">RECONCILIATION</span>
        </div>
        <div class="pane-body fullpane-body">
          <ReconciliationPanel />
        </div>
      </div>
    {:else if workspace.activeTab === "settings"}
      <div class="fullpane-viewport">
        <div class="pane-header">
          <span class="pane-title">SETTINGS</span>
        </div>
        <div class="pane-body fullpane-body">
          <SettingsPanel health={workspace.health} />
        </div>
      </div>
    {/if}

    <GraphActionsMenu {workspace} />
    <!-- ADR 014 step 8 — Plan review modal -->
    <PlanReviewDialog {workspace} />
    <WorkItemDispositionDialogs {workspace} />
    <!-- Status bar -->
    <WorkspaceStatusBar {workspace} />

  </div>
</div>
<style>
  .app-shell {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    height: 100vh;
    overflow: hidden;
  }
  .main-area {
    display: grid;
    grid-template-rows: 30px minmax(0, 1fr) 22px;
    overflow: hidden;
    background: #0d1117;
  }
  .title-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    background: #181d28;
    border-bottom: 1px solid #2b3245;
    padding: 0 12px;
    position: relative;
  }

  .title-bar-label {
    position: absolute;
    left: 12px;
    font-size: 11px;
    font-weight: 600;
    color: #8b95a5;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .title-bar-brand {
    font-size: 11px;
    color: #6b7a94;
    letter-spacing: 0.02em;
  }

  .title-bar-spacer {
    flex: 1;
  }
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
  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }
  .fullpane-viewport {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .fullpane-body {
    overflow-y: auto;
    padding: 0;
  }
  @media (max-width: 860px) {
    .app-shell {
      grid-template-columns: 40px minmax(0, 1fr);
    }
  }
</style>
