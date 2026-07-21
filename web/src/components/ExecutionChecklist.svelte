<script>
  /** @type {{run_id: string, revision: number, updated_at: string | null, items: Array<{text: string, checked: boolean, category: string}>, completed: number, total: number} | null} */
  export let snapshot = null;

  $: items = snapshot?.items || [];
  $: implementation = items.filter((item) => item.category === "implementation");
  $: acceptance = items.filter((item) => item.category === "acceptance");
  $: verification = items.filter((item) => item.category === "verification");
  $: completedCount = snapshot?.completed ?? 0;
  $: totalCount = snapshot?.total ?? 0;
  $: progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  $: allDone = completedCount === totalCount && totalCount > 0;
  $: updatedLabel = snapshot?.updated_at
    ? new Date(snapshot.updated_at).toLocaleString()
    : "not yet persisted";

  function groupCompleted(group) {
    return group.filter((item) => item.checked).length;
  }
</script>

{#if snapshot}
  <div class="checklist-surface" class:checklist-complete={allDone}>
    <div class="checklist-header">
      <span class="checklist-title">Implementation</span>
      <span class="checklist-progress-label">{completedCount}/{totalCount}</span>
    </div>

    <div class="checklist-progress-bar" aria-label={`Implementation progress: ${completedCount} of ${totalCount}`}>
      <div class="checklist-progress-fill" style="width: {progressPercent}%"></div>
    </div>

    {#if implementation.length}
      <ul class="checklist-items">
        {#each implementation as item}
          <li class="checklist-item" class:checked={item.checked}>
            <span class="checklist-check">{item.checked ? "☑" : "☐"}</span>
            <span class="checklist-text">{item.text}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="checklist-empty">No implementation tasks.</div>
    {/if}

    {#if acceptance.length}
      <div class="checklist-group-header">
        <span>Acceptance criteria</span>
        <span>{groupCompleted(acceptance)}/{acceptance.length}</span>
      </div>
      <ul class="checklist-items secondary-group">
        {#each acceptance as item}
          <li class="checklist-item" class:checked={item.checked}>
            <span class="checklist-check">{item.checked ? "☑" : "☐"}</span>
            <span class="checklist-text">{item.text}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if verification.length}
      <div class="checklist-group-header">
        <span>Verification</span>
        <span>{groupCompleted(verification)}/{verification.length}</span>
      </div>
      <ul class="checklist-items secondary-group">
        {#each verification as item}
          <li class="checklist-item" class:checked={item.checked}>
            <span class="checklist-check">{item.checked ? "☑" : "☐"}</span>
            <span class="checklist-text">{item.text}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="checklist-freshness" title={snapshot.updated_at || "Checklist has not been persisted yet"}>
      Checklist updated {updatedLabel}
    </div>
  </div>
{/if}

<style>
  .checklist-surface {
    border: 1px solid rgba(96, 165, 250, 0.2);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(15, 23, 42, 0.55);
  }
  .checklist-complete { border-color: rgba(34, 197, 94, 0.3); }
  .checklist-header, .checklist-group-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.7rem;
    background: rgba(30, 41, 59, 0.6);
    border-bottom: 1px solid rgba(148, 163, 184, 0.08);
  }
  .checklist-title, .checklist-group-header {
    font-size: 0.72rem;
    font-weight: 600;
    color: #93c5fd;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .checklist-complete .checklist-title { color: #86efac; }
  .checklist-progress-label, .checklist-group-header span:last-child {
    margin-left: auto;
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }
  .checklist-progress-bar { height: 3px; background: rgba(30, 41, 59, 0.8); }
  .checklist-progress-fill {
    height: 100%;
    background: #3b82f6;
    transition: width 0.4s ease;
    border-radius: 0 2px 2px 0;
  }
  .checklist-complete .checklist-progress-fill { background: #22c55e; }
  .checklist-items { list-style: none; margin: 0; padding: 0.35rem 0; }
  .secondary-group { background: rgba(15, 23, 42, 0.25); }
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
  .checklist-check { flex-shrink: 0; font-size: 0.85rem; line-height: 1; }
  .checklist-item:not(.checked) .checklist-check { color: #60a5fa; }
  .checklist-item.checked .checklist-check { color: #22c55e; }
  .checklist-text { word-break: break-word; }
  .checklist-empty, .checklist-freshness {
    padding: 0.45rem 0.7rem;
    font-size: 0.72rem;
    color: #64748b;
  }
  .checklist-freshness {
    border-top: 1px solid rgba(148, 163, 184, 0.08);
    text-align: right;
  }
</style>
