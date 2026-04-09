<script>
  import { createEventDispatcher } from "svelte";
  import ExecutionDispatchListItem from "./ExecutionDispatchListItem.svelte";

  export let groups = [];
  export let selectedDispatchId = null;
  export let launchingIds = [];

  const dispatch = createEventDispatcher();
</script>

<section class="dispatch-list-section">
  <div class="nav-section-header">
    <h3>DISPATCH</h3>
    <span class="nav-count">{groups.reduce((sum, group) => sum + group.nodes.length, 0)}</span>
  </div>

  {#if groups.length === 0}
    <div class="nav-empty muted">No dispatchable groups.</div>
  {:else}
    {#each groups as group}
      <div class="dispatch-group">
        <div class="dispatch-group-label">
          <strong>{group.group_id}</strong>
          <span class="muted">{group.repo} · {group.nodes.length}</span>
        </div>
        <div class="dispatch-group-items">
          {#each group.nodes as node}
            <ExecutionDispatchListItem
              {node}
              selected={node.id === selectedDispatchId}
              launching={launchingIds.includes(node.id)}
              on:select={(event) => dispatch("select", event.detail)}
              on:launch={(event) => dispatch("launch", event.detail)}
            />
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</section>

<style>
  .dispatch-list-section {
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

  .dispatch-group {
    display: grid;
    gap: 2px;
  }

  .dispatch-group-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    font-size: 11px;
  }

  .dispatch-group-items {
    display: grid;
    gap: 2px;
  }

  .nav-empty {
    padding: 8px;
    font-size: 11px;
  }
</style>
