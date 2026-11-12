<script>

import ExecutionDispatchList from "./ExecutionDispatchList.svelte";
import ExecutionDetailPane from "./ExecutionDetailPane.svelte";

import { refreshGitHubCache } from "../lib/api.js";

import { createWorkspace } from '../lib/execution/workspace.svelte.js';
const workspace = createWorkspace();

import ExecutionRunWorkspace from './ExecutionRunWorkspace.svelte';
import ExecutionConfirmationDrawer from './ExecutionConfirmationDrawer.svelte';
</script>
<section class="execution-panel">
  <!-- Top bar: status + summary -->
  <div class="exec-topbar">
    <div class="exec-topbar-left">
      <span class:healthy={workspace.connected} class="status-pill">{workspace.connected ? "stream connected" : "reconnecting"}</span>
      <span
        class="status-pill {workspace.syncTone}"
        role="status"
        aria-live="polite"
        title={workspace.syncError?.message || workspace.syncLabel}
      >{workspace.syncLabel}</span>
      {#if workspace.preview}
        <span class="exec-stat">{workspace.preview.summary.dispatchable_now} dispatchable</span>
        <span class="exec-stat">{workspace.activeRuns.length} active</span>
        <span class="exec-stat">{workspace.completedRuns.length} done</span>
        {#if workspace.suspectRuns.length > 0}
          <span class="exec-stat warn">{workspace.suspectRuns.length} suspect</span>
        {/if}
        {#if workspace.blockedRuns.length + workspace.failedRuns.length > 0}
          <span class="exec-stat warn">{workspace.blockedRuns.length + workspace.failedRuns.length} failed</span>
        {/if}
      {/if}
    </div>
    <button class="secondary small" on:click={async () => { workspace.refreshing = true; try { await refreshGitHubCache(); } catch (e) { /* best-effort */ } await workspace.requestDataSync(); }} disabled={workspace.refreshing || workspace.loading}>{workspace.refreshing ? "Refreshing..." : "Refresh"}</button>
  </div>

  {#if workspace.copiedMessage}
    <div class="banner success inline-banner" aria-live="polite">{workspace.copiedMessage}</div>
  {/if}
  {#if workspace.error}
    <div class="banner error inline-banner">{workspace.error}</div>
  {/if}

  {#if workspace.loading}
    <div class="empty-state">Loading execution workspace...</div>
  {:else if !workspace.preview}
    <div class="empty-state">Execution preview unavailable.</div>
  {:else}
    <div class="exec-columns">
      <!-- Left: Dispatch queue -->
      <div class="exec-col-dispatch">
        <ExecutionDispatchList
          groups={workspace.preview.groups}
          selectedDispatchId={workspace.activeSelection === "dispatch" ? workspace.selectedDispatchId : null}
          launchingIds={workspace.launchingIds}
          on:select={(e) => workspace.selectDispatch(e.detail.id)}
          on:launch={(e) => workspace.launchNodeById(e.detail.id)}
        />
      </div>

      <!-- Middle: Details/context for selected item -->
      <div class="exec-col-details">
        <ExecutionDetailPane
          kind={workspace.activeSelection}
          fastForwardPending={!!workspace.fastForwardPending[workspace.selectedDispatchId]}
          fastForwardError={workspace.fastForwardErrors[workspace.selectedDispatchId] || ""}
          on:fastforwardbase={() => workspace.selectedDispatch && workspace.handleFastForward(workspace.selectedDispatch)}
          run={workspace.activeSelection === "run" ? workspace.selectedRun : null}
          dispatchNode={workspace.activeSelection === "dispatch" ? workspace.selectedDispatch : null}
          pullRequest={workspace.selectedPullRequest}
          openingPr={workspace.selectedRun ? workspace.openingPrRunIds.includes(workspace.selectedRun.run_id) : false}
          canDispose={workspace.selectedRun ? workspace.canDisposeRun(workspace.selectedRun) : false}
          disposing={workspace.selectedRun ? workspace.disposingRunIds.includes(workspace.selectedRun.run_id) : false}
          dispositionError={workspace.selectedRun ? (workspace.dispositionErrors[workspace.selectedRun.run_id] || "") : ""}
          recovery={workspace.selectedRecovery}
          assumptions={workspace.preview.assumptions || []}
          validationPolicy={workspace.preview.validation_policy}
          on:copybranch={() => {
            if (workspace.activeSelection === "run" && workspace.selectedRun) workspace.copyValue(workspace.selectedRun.branch, `Copied branch ${workspace.selectedRun.branch}`);
            else if (workspace.activeSelection === "dispatch" && workspace.selectedDispatch) workspace.copyValue(workspace.selectedDispatch.branch, `Copied branch ${workspace.selectedDispatch.branch}`);
          }}
          on:copyworktree={() => {
            if (workspace.activeSelection === "run" && workspace.selectedRun) workspace.copyValue(workspace.selectedRun.worktree_path, `Copied worktree`);
            else if (workspace.activeSelection === "dispatch" && workspace.selectedDispatch) workspace.copyValue(workspace.selectedDispatch.worktree_path, `Copied worktree`);
          }}
          on:openpr={() => workspace.selectedRun && workspace.handleOpenPR(workspace.selectedRun)}
          on:closeRun={() => workspace.selectedRun && workspace.handleCloseRun(workspace.selectedRun)}
          on:archiveAndCloseRun={() => workspace.selectedRun && workspace.handleArchiveAndCloseRun(workspace.selectedRun)}
          on:redispatch={() => workspace.selectedRun && workspace.handleRedispatch(workspace.selectedRun)}
          on:launch={() => workspace.selectedDispatch && workspace.launchNode(workspace.selectedDispatch)}
          scratchpadContent={workspace.selectedRun ? workspace.scratchpadContent[workspace.selectedRun.run_id] : undefined}
          scratchpadLoading={workspace.selectedRun ? !!workspace.scratchpadLoading[workspace.selectedRun.run_id] : false}
          on:scratchpadtoggle={() => workspace.selectedRun && workspace.loadScratchpad(workspace.selectedRun.run_id)}
        />
      </div>

      <!-- Right: Workspace (run pills + active run content) -->
      <ExecutionRunWorkspace {workspace} />
    </div>

    <ExecutionConfirmationDrawer {workspace} />
  {/if}
</section>
<style>
  .execution-panel {
    position: relative;
    isolation: isolate;
  }
  .exec-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-shrink: 0;
    padding: 0 2px;
  }

  .exec-topbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .exec-stat {
    font-size: 11px;
    color: var(--text-muted, #566070);
  }

  .exec-stat.warn {
    color: var(--red, #f85149);
  }
  .exec-columns {
    display: grid;
    grid-template-columns: 220px 300px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .exec-col-dispatch {
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    border-right: 1px solid var(--border, #2b3245);
    padding: 6px;
  }

  .exec-col-details {
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    border-right: 1px solid var(--border, #2b3245);
  }
  @media (max-width: 1100px) {
    .exec-columns {
      grid-template-columns: 200px minmax(0, 1fr);
      grid-template-rows: minmax(360px, 1fr) minmax(240px, 1fr);
      overflow-y: auto;
    }

    .exec-columns :global(.exec-col-workspace) {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 860px) {
    .exec-columns {
      grid-template-columns: 1fr;
      grid-template-rows: auto;
      grid-auto-rows: minmax(240px, auto);
      overflow-y: auto;
    }

    .exec-col-dispatch {
      border-right: none;
      border-bottom: 1px solid var(--border, #2b3245);
    }
  }
</style>
