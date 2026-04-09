<script>
  import { createEventDispatcher } from "svelte";

  export let node;
  export let selected = false;
  export let launching = false;

  const dispatch = createEventDispatcher();

  function safetySummary(checks = []) {
    const failed = checks.filter((check) => check.status === "fail").length;
    const warned = checks.filter((check) => check.status === "warn").length;
    if (failed > 0) return `${failed} blocking`;
    if (warned > 0) return `${warned} warn`;
    return "ready";
  }
</script>

<div
  class:selected
  class="dispatch-item"
  on:click={() => dispatch("select", { id: node.id })}
  on:keydown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      dispatch("select", { id: node.id });
    }
  }}
  role="button"
  tabindex="0"
>
  <div class="dispatch-item-top">
    <strong class="dispatch-item-id">{node.id}</strong>
    <span class="status-pill {node.can_launch ? 'healthy' : 'warn'}">{node.can_launch ? 'ready' : 'blocked'}</span>
  </div>
  <span class="dispatch-item-name muted">{node.name}</span>
  <div class="dispatch-item-meta">
    <code>{node.branch}</code>
    <span>{safetySummary(node.safety_checks)}</span>
  </div>
  <div class="dispatch-item-actions">
    <button
      class="small"
      on:click|stopPropagation={() => dispatch("launch", { id: node.id })}
      disabled={!node.can_launch || launching}
    >
      {launching ? 'Launching...' : node.can_launch ? 'Launch' : 'Blocked'}
    </button>
  </div>
</div>

<style>
  .dispatch-item {
    display: grid;
    gap: 2px;
    padding: 5px 6px;
    border-radius: var(--radius-sm, 3px);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    font-size: 12px;
  }

  .dispatch-item:hover {
    background: rgba(255, 255, 255, 0.03);
    border-color: var(--border, #2b3245);
  }

  .dispatch-item.selected {
    background: var(--accent-muted, rgba(37, 99, 235, 0.25));
    border-color: rgba(37, 99, 235, 0.5);
  }

  .dispatch-item-top {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    align-items: center;
  }

  .dispatch-item-id {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dispatch-item-name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dispatch-item-meta {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    font-size: 10.5px;
    color: var(--text-muted, #566070);
  }

  .dispatch-item-meta code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
  }

  .dispatch-item-actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 2px;
  }
</style>
