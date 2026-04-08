<script>
  import { createEventDispatcher } from "svelte";

  export let kind = null;
  export let run = null;
  export let dispatchNode = null;
  export let pullRequest = null;
  export let openingPr = false;

  const dispatch = createEventDispatcher();

  function formatSafetySummary(checks = []) {
    const failed = checks.filter((check) => check.status === "fail").length;
    const warned = checks.filter((check) => check.status === "warn").length;
    if (failed > 0) return `${failed} blocking`;
    if (warned > 0) return `${warned} warning${warned === 1 ? "" : "s"}`;
    return "All checks passed";
  }

  function statusTone(status) {
    if (status === "completed") return "healthy";
    if (["running", "preparing", "queued"].includes(status)) return "info";
    if (status === "disambiguating") return "disambiguating";
    if (status === "blocked") return "warn";
    if (status === "error") return "danger";
    return "";
  }
</script>

<aside class="context-sidebar">
  {#if kind === "run" && run}
    <div class="sidebar-section">
      <div class="sidebar-section-hdr">
        <h3>CONTEXT</h3>
        <span class="status-pill {statusTone(run.status)}">{run.status}</span>
      </div>

      <div class="sidebar-kv-list">
        <div class="sidebar-kv"><span class="muted">Branch</span><code>{run.branch}</code></div>
        <div class="sidebar-kv"><span class="muted">Base</span><code>{run.base_ref}</code></div>
        <div class="sidebar-kv"><span class="muted">Worktree</span><code>{run.worktree_path}</code></div>
        <div class="sidebar-kv"><span class="muted">Artifacts</span><code>{run.artifact_dir}</code></div>
      </div>

      <div class="sidebar-actions">
        {#if run.issue_url}
          <a class="sidebar-link" href={run.issue_url} target="_blank" rel="noreferrer">Issue</a>
        {/if}
        <button class="secondary small" on:click={() => dispatch("copybranch")}>Copy branch</button>
        <button class="secondary small" on:click={() => dispatch("copyworktree")}>Copy worktree</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-hdr"><h3>PR</h3></div>
      {#if pullRequest}
        <a class="sidebar-link" href={pullRequest.url} target="_blank" rel="noreferrer">PR #{pullRequest.number}</a>
      {:else if run.status === "completed"}
        <button on:click={() => dispatch("openpr")} disabled={openingPr}>
          {openingPr ? "Opening..." : "Open PR"}
        </button>
      {:else}
        <p class="muted">Available after completion.</p>
      {/if}

      {#if run.changed_files?.length}
        <div class="sidebar-file-list">
          <div class="muted">Changed files</div>
          <ul>{#each run.changed_files as path}<li>{path}</li>{/each}</ul>
        </div>
      {/if}
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-hdr"><h3>CHECKS</h3></div>
      <p class="muted">{formatSafetySummary(run.safety_checks || [])}</p>
      {#if run.errors?.length}
        <ul class="sidebar-error-list">
          {#each run.errors as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}
        </ul>
      {:else}
        <p class="muted">No errors.</p>
      {/if}
    </div>

  {:else if kind === "dispatch" && dispatchNode}
    <div class="sidebar-section">
      <div class="sidebar-section-hdr">
        <h3>CONTEXT</h3>
        <span class="status-pill {dispatchNode.can_launch ? 'healthy' : 'warn'}">{dispatchNode.can_launch ? 'ready' : 'blocked'}</span>
      </div>

      <div class="sidebar-kv-list">
        <div class="sidebar-kv"><span class="muted">Branch</span><code>{dispatchNode.branch}</code></div>
        <div class="sidebar-kv"><span class="muted">Base</span><code>{dispatchNode.default_base_ref}</code></div>
        <div class="sidebar-kv"><span class="muted">Worktree</span><code>{dispatchNode.worktree_path}</code></div>
      </div>

      <div class="sidebar-actions">
        {#if dispatchNode.issue_url}
          <a class="sidebar-link" href={dispatchNode.issue_url} target="_blank" rel="noreferrer">Issue</a>
        {/if}
        <button class="secondary small" on:click={() => dispatch("copybranch")}>Copy branch</button>
        <button class="secondary small" on:click={() => dispatch("copyworktree")}>Copy worktree</button>
        <button on:click={() => dispatch("launch")} disabled={!dispatchNode.can_launch}>
          {dispatchNode.can_launch ? 'Launch' : 'Blocked'}
        </button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-hdr"><h3>SAFETY</h3></div>
      <p class="muted">{formatSafetySummary(dispatchNode.safety_checks)}</p>
      {#if dispatchNode.safety_checks?.length}
        <ul class="sidebar-check-list">
          {#each dispatchNode.safety_checks as check}
            <li><strong>{check.code}</strong>: {check.message}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div class="sidebar-section sidebar-empty">
      <p class="muted">Select a run or dispatch candidate.</p>
    </div>
  {/if}
</aside>

<style>
  .context-sidebar {
    display: flex;
    flex-direction: column;
    gap: 1px;
    align-content: start;
    min-width: 0;
    padding: 6px;
  }

  .sidebar-section {
    display: grid;
    gap: 6px;
    padding: 8px;
    background: var(--bg-surface, #13171f);
    border-radius: var(--radius-sm, 3px);
    font-size: 12px;
  }

  .sidebar-section-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
  }

  .sidebar-section-hdr h3 {
    margin: 0;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-secondary, #8b95a5);
    letter-spacing: 0.08em;
  }

  .sidebar-kv-list {
    display: grid;
    gap: 4px;
  }

  .sidebar-kv {
    display: grid;
    gap: 1px;
    font-size: 11px;
  }

  .sidebar-kv code {
    overflow-wrap: anywhere;
    font-size: 10.5px;
  }

  .sidebar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  .sidebar-link {
    font-size: 11px;
    color: #58a6ff;
    text-decoration: none;
  }

  .sidebar-link:hover { text-decoration: underline; }

  .sidebar-file-list {
    display: grid;
    gap: 2px;
    font-size: 11px;
  }

  .sidebar-file-list ul {
    margin: 0;
    padding-left: 14px;
    font-size: 11px;
  }

  .sidebar-error-list,
  .sidebar-check-list {
    margin: 0;
    padding-left: 14px;
    font-size: 11px;
  }

  .sidebar-empty {
    min-height: 6rem;
    place-items: center;
    display: grid;
  }
</style>
