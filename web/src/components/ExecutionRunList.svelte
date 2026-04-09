<script>
  import { createEventDispatcher } from "svelte";
  import ExecutionRunListItem from "./ExecutionRunListItem.svelte";

  export let runs = [];
  export let selectedRunId = null;
  export let filter = "all";

  const dispatch = createEventDispatcher();

  const filters = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "completed", label: "Done" },
    { id: "failed", label: "Failed" },
  ];

  function matchesFilter(run, currentFilter) {
    if (currentFilter === "active") {
      return ["queued", "preparing", "running", "disambiguating"].includes(run.status);
    }
    if (currentFilter === "completed") {
      return run.status === "completed";
    }
    if (currentFilter === "failed") {
      return ["error", "blocked"].includes(run.status);
    }
    return true;
  }

  function countFor(currentFilter) {
    return runs.filter((run) => matchesFilter(run, currentFilter)).length;
  }

  $: filteredRuns = runs.filter((run) => matchesFilter(run, filter));
</script>

<section class="run-list-section">
  <div class="nav-section-header">
    <h3>RUNS</h3>
    <span class="nav-count">{runs.length}</span>
  </div>

  <div class="run-filter-tabs">
    {#each filters as tab}
      <button
        class:selected={filter === tab.id}
        class="run-filter-tab"
        on:click={() => dispatch("changefilter", { filter: tab.id })}
      >
        {tab.label} <span class="filter-count">{countFor(tab.id)}</span>
      </button>
    {/each}
  </div>

  {#if filteredRuns.length === 0}
    <div class="nav-empty muted">No runs match this filter.</div>
  {:else}
    <div class="run-list-items">
      {#each filteredRuns as run}
        <ExecutionRunListItem
          {run}
          selected={run.run_id === selectedRunId}
          on:select={(event) => dispatch("select", event.detail)}
        />
      {/each}
    </div>
  {/if}
</section>

<style>
  .run-list-section {
    display: grid;
    gap: 4px;
    align-content: start;
  }

  .nav-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 2px;
  }

  .nav-section-header h3 {
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-secondary, #8b95a5);
    letter-spacing: 0.08em;
    margin: 0;
  }

  .nav-count {
    font-size: 10.5px;
    color: var(--text-muted, #566070);
  }

  .run-filter-tabs {
    display: flex;
    gap: 1px;
    background: var(--border, #2b3245);
    border-radius: var(--radius-sm, 3px);
    overflow: hidden;
  }

  .run-filter-tab {
    flex: 1;
    display: inline-flex;
    gap: 3px;
    align-items: center;
    justify-content: center;
    padding: 3px 6px;
    background: var(--bg-surface, #13171f);
    color: var(--text-muted, #566070);
    font-size: 10.5px;
    font-weight: 600;
    border-radius: 0;
    border: none;
  }

  .run-filter-tab:hover {
    background: var(--bg-raised, #1a1f2e);
    color: var(--text-secondary, #8b95a5);
  }

  .run-filter-tab.selected {
    background: var(--accent-muted, rgba(37, 99, 235, 0.25));
    color: #bfdbfe;
  }

  .filter-count {
    opacity: 0.7;
  }

  .run-list-items {
    display: grid;
    gap: 2px;
  }

  .nav-empty {
    padding: 8px;
    font-size: 11px;
  }
</style>
