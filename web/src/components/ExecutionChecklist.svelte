<script>
  /** @type {Array<{text: string, checked: boolean}>} */
  export let items = [];

  $: completedCount = items.filter((item) => item.checked).length;
  $: totalCount = items.length;
  $: progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  $: allDone = completedCount === totalCount && totalCount > 0;
</script>

{#if items.length > 0}
  <div class="checklist-surface" class:checklist-complete={allDone}>
    <div class="checklist-header">
      <span class="checklist-title">Checklist</span>
      <span class="checklist-progress-label">{completedCount}/{totalCount}</span>
    </div>

    <div class="checklist-progress-bar">
      <div class="checklist-progress-fill" style="width: {progressPercent}%"></div>
    </div>

    <ul class="checklist-items">
      {#each items as item}
        <li class="checklist-item" class:checked={item.checked}>
          <span class="checklist-check">{item.checked ? "☑" : "☐"}</span>
          <span class="checklist-text">{item.text}</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .checklist-surface {
    border: 1px solid rgba(96, 165, 250, 0.2);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(15, 23, 42, 0.55);
  }

  .checklist-complete {
    border-color: rgba(34, 197, 94, 0.3);
  }

  .checklist-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.7rem;
    background: rgba(30, 41, 59, 0.6);
    border-bottom: 1px solid rgba(148, 163, 184, 0.08);
  }

  .checklist-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: #93c5fd;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .checklist-complete .checklist-title {
    color: #86efac;
  }

  .checklist-progress-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: #e2e8f0;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }

  .checklist-progress-bar {
    height: 3px;
    background: rgba(30, 41, 59, 0.8);
  }

  .checklist-progress-fill {
    height: 100%;
    background: #3b82f6;
    transition: width 0.4s ease;
    border-radius: 0 2px 2px 0;
  }

  .checklist-complete .checklist-progress-fill {
    background: #22c55e;
  }

  .checklist-items {
    list-style: none;
    margin: 0;
    padding: 0.35rem 0;
  }

  .checklist-item {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.2rem 0.7rem;
    font-size: 0.82rem;
    color: #cbd5e1;
    line-height: 1.4;
  }

  .checklist-item.checked {
    color: #64748b;
    text-decoration: line-through;
    text-decoration-color: rgba(100, 116, 139, 0.5);
  }

  .checklist-check {
    flex-shrink: 0;
    font-size: 0.85rem;
    line-height: 1;
  }

  .checklist-item:not(.checked) .checklist-check {
    color: #60a5fa;
  }

  .checklist-item.checked .checklist-check {
    color: #22c55e;
  }

  .checklist-text {
    word-break: break-word;
  }
</style>
