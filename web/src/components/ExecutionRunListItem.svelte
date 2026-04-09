<script>
  import { createEventDispatcher } from "svelte";

  export let run;
  export let selected = false;

  const dispatch = createEventDispatcher();

  function runStatusTone(status) {
    if (status === "completed") return "healthy";
    if (["running", "preparing", "queued"].includes(status)) return "info";
    if (status === "disambiguating") return "disambiguating";
    if (status === "blocked") return "warn";
    if (status === "error") return "danger";
    return "";
  }

  function formatUpdated(value) {
    if (!value) return "";
    try {
      return new Date(value).toLocaleTimeString();
    } catch {
      return "";
    }
  }
</script>

<button class:selected class="run-item" on:click={() => dispatch("select", { run_id: run.run_id })}>
  <div class="run-item-top">
    <strong class="run-item-id">{run.work_item_id}</strong>
    <span class="status-pill {runStatusTone(run.status)}">{run.status}</span>
  </div>
  <span class="run-item-name muted">{run.work_item_name}</span>
  <div class="run-item-meta">
    <code>{run.branch}</code>
    {#if run.updated_at}<span>{formatUpdated(run.updated_at)}</span>{/if}
  </div>
  {#if run.pull_request || run.errors?.length || run.changed_files?.length}
    <div class="run-item-badges">
      {#if run.pull_request}<span class="mini-badge">PR #{run.pull_request.number}</span>{/if}
      {#if run.errors?.length}<span class="mini-badge danger">{run.errors.length} err</span>{/if}
      {#if run.changed_files?.length}<span class="mini-badge">{run.changed_files.length} files</span>{/if}
    </div>
  {/if}
</button>

<style>
  .run-item {
    width: 100%;
    display: grid;
    gap: 2px;
    text-align: left;
    padding: 5px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 3px);
    color: var(--text-primary, #e2e8f0);
    font-size: 12px;
  }

  .run-item:hover {
    background: rgba(255, 255, 255, 0.03);
    border-color: var(--border, #2b3245);
  }

  .run-item.selected {
    background: var(--accent-muted, rgba(37, 99, 235, 0.25));
    border-color: rgba(37, 99, 235, 0.5);
  }

  .run-item-top {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    align-items: center;
  }

  .run-item-id {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .run-item-name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .run-item-meta {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    font-size: 10.5px;
    color: var(--text-muted, #566070);
  }

  .run-item-meta code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
  }

  .run-item-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .mini-badge {
    display: inline-flex;
    padding: 0 4px;
    border-radius: 2px;
    background: rgba(148, 163, 184, 0.1);
    color: var(--text-muted, #566070);
    font-size: 10px;
  }

  .mini-badge.danger {
    color: #fca5a5;
    background: rgba(248, 81, 73, 0.1);
  }
</style>
