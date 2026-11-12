<script>

/** @type {ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace>} */
export let workspace;
</script>
<footer class="status-bar">
      <div class="status-bar-left">
        <span class="status-indicator" class:healthy={workspace.health?.ok}></span>
        <span class="status-text">{workspace.health?.ok ? "Connected" : "Disconnected"}</span>
        {#if workspace.activeTab === "planning"}
          <span class="status-sep">|</span>
          <span class="status-text">{workspace.graph.items.length} items</span>
          <span class="status-sep">·</span>
          <span class="status-text">{workspace.graph.edges.length} edges</span>
          <span class="status-sep">·</span>
          <span class="status-text">{workspace.frontierCount} frontier</span>
          <span class="status-sep">·</span>
          <span class="status-text">{workspace.blockedCount} blocked</span>
          {#if workspace.activeFilterCount > 0}
            <span class="status-sep">|</span>
            <span class="status-text">{workspace.activeFilterCount} filter{workspace.activeFilterCount > 1 ? "s" : ""} active</span>
          {/if}
        {:else if workspace.activeTab === "execute"}
          <span class="status-sep">|</span>
          <span class="status-text">{workspace.activeRunCount} active run{workspace.activeRunCount !== 1 ? "s" : ""}</span>
          <span class="status-sep">·</span>
          <span class="status-text">{workspace.completedTodayCount} completed today</span>
          {#if workspace.successRate !== null}
            <span class="status-sep">·</span>
            <span class="status-text">{workspace.successRate}% success rate</span>
          {/if}
        {:else if workspace.activeTab === "reconciliation"}
          <span class="status-sep">|</span>
          <span class="status-text">{workspace.readyToMergeCount} ready to merge</span>
          <span class="status-sep">·</span>
          <span class="status-text">{workspace.conflictsCount} conflict{workspace.conflictsCount !== 1 ? "s" : ""}</span>
          <span class="status-sep">·</span>
          <span class="status-text">{workspace.staleCount} stale</span>
        {/if}
      </div>
      <div class="status-bar-right">
        <span class="status-text">Escapement Studio</span>
      </div>
    </footer>
<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    background: #1a1f2e;
    border-top: 1px solid #2b3245;
    padding: 0 10px;
    font-size: 11px;
    color: #6b7a94;
    gap: 8px;
    flex-shrink: 0;
  }

  .status-bar-left,
  .status-bar-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #5c3a3a;
    flex-shrink: 0;
  }

  .status-indicator.healthy {
    background: #3fb950;
  }

  .status-text {
    white-space: nowrap;
  }

  .status-sep {
    color: #3b4559;
    margin: 0 2px;
    user-select: none;
  }
</style>
