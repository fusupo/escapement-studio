<script>
  import { createEventDispatcher } from "svelte";

  export let kind = null;
  export let run = null;
  export let dispatchNode = null;
  export let pullRequest = null;
  export let openingPr = false;
  export let assumptions = [];
  export let validationPolicy = null;

  const dispatch = createEventDispatcher();

  function statusTone(status) {
    if (status === "completed") return "healthy";
    if (["running", "preparing", "queued"].includes(status)) return "info";
    if (status === "disambiguating") return "disambiguating";
    if (status === "blocked") return "warn";
    if (status === "error") return "danger";
    return "";
  }

  function formatTimestamp(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); } catch { return ""; }
  }

  function formatSafetySummary(checks = []) {
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    if (failed > 0) return `${failed} blocking`;
    if (warned > 0) return `${warned} warning${warned === 1 ? "" : "s"}`;
    return "All passed";
  }
</script>

<div class="detail-col">
  {#if kind === "run" && run}
    <!-- Context -->
    <div class="detail-card">
      <div class="detail-card-hdr">
        <h3>CONTEXT</h3>
        <span class="status-pill {statusTone(run.status)}">{run.status}</span>
      </div>
      <div class="detail-kv-list">
        <div class="detail-kv"><span class="muted">Branch</span><code>{run.branch}</code></div>
        <div class="detail-kv"><span class="muted">Base</span><code>{run.base_ref}</code></div>
        <div class="detail-kv"><span class="muted">Worktree</span><code>{run.worktree_path}</code></div>
        <div class="detail-kv"><span class="muted">Artifacts</span><code>{run.artifact_dir}</code></div>
      </div>
      <div class="detail-actions">
        {#if run.issue_url}
          <a class="detail-link" href={run.issue_url} target="_blank" rel="noreferrer">Issue</a>
        {/if}
        <button class="secondary small" on:click={() => dispatch("copybranch")}>Copy branch</button>
        <button class="secondary small" on:click={() => dispatch("copyworktree")}>Copy worktree</button>
      </div>
    </div>

    <!-- Timestamps -->
    <div class="detail-card">
      <div class="detail-card-hdr"><h3>TIMELINE</h3></div>
      <div class="detail-kv-list">
        <div class="detail-kv"><span class="muted">Created</span><span>{formatTimestamp(run.created_at)}</span></div>
        <div class="detail-kv"><span class="muted">Updated</span><span>{formatTimestamp(run.updated_at)}</span></div>
        {#if run.started_at}<div class="detail-kv"><span class="muted">Started</span><span>{formatTimestamp(run.started_at)}</span></div>{/if}
        {#if run.completed_at}<div class="detail-kv"><span class="muted">Completed</span><span>{formatTimestamp(run.completed_at)}</span></div>{/if}
      </div>
    </div>

    <!-- PR -->
    <div class="detail-card">
      <div class="detail-card-hdr"><h3>PR</h3></div>
      {#if pullRequest}
        <a class="detail-link" href={pullRequest.url} target="_blank" rel="noreferrer">PR #{pullRequest.number}</a>
      {:else if run.status === "completed"}
        <button on:click={() => dispatch("openpr")} disabled={openingPr}>
          {openingPr ? "Opening..." : "Open PR"}
        </button>
      {:else}
        <p class="muted">Available after completion.</p>
      {/if}
    </div>

    <!-- Safety -->
    <div class="detail-card">
      <div class="detail-card-hdr"><h3>CHECKS</h3></div>
      <p class="muted">{formatSafetySummary(run.safety_checks || [])}</p>
      {#if run.errors?.length}
        <ul class="detail-list">
          {#each run.errors as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}
        </ul>
      {/if}
    </div>

  {:else if kind === "dispatch" && dispatchNode}
    <!-- Context -->
    <div class="detail-card">
      <div class="detail-card-hdr">
        <h3>CONTEXT</h3>
        <span class="status-pill {dispatchNode.can_launch ? 'healthy' : 'warn'}">{dispatchNode.can_launch ? 'ready' : 'blocked'}</span>
      </div>
      <div class="detail-kv-list">
        <div class="detail-kv"><span class="muted">Repo</span><span>{dispatchNode.repo}</span></div>
        <div class="detail-kv"><span class="muted">Group</span><span>{dispatchNode.group_id}</span></div>
        <div class="detail-kv"><span class="muted">Branch</span><code>{dispatchNode.branch}</code></div>
        <div class="detail-kv"><span class="muted">Base</span><code>{dispatchNode.default_base_ref}</code></div>
        <div class="detail-kv"><span class="muted">Worktree</span><code>{dispatchNode.worktree_path}</code></div>
      </div>
      <div class="detail-actions">
        {#if dispatchNode.issue_url}
          <a class="detail-link" href={dispatchNode.issue_url} target="_blank" rel="noreferrer">Issue</a>
        {/if}
        <button class="secondary small" on:click={() => dispatch("copybranch")}>Copy branch</button>
        <button class="secondary small" on:click={() => dispatch("copyworktree")}>Copy worktree</button>
        <button on:click={() => dispatch("launch")} disabled={!dispatchNode.can_launch}>
          {dispatchNode.can_launch ? 'Launch' : 'Blocked'}
        </button>
      </div>
    </div>

    <!-- Scope -->
    {#if dispatchNode.scope_hint}
      <div class="detail-card">
        <div class="detail-card-hdr"><h3>SCOPE</h3></div>
        <p>{dispatchNode.scope_hint}</p>
        <div class="scope-lists">
          <div>
            <span class="muted">Owned</span>
            <ul class="detail-list">{#each dispatchNode.files_owned as p}<li>{p}</li>{:else}<li class="muted">(none)</li>{/each}</ul>
          </div>
          <div>
            <span class="muted">Shared</span>
            <ul class="detail-list">{#each dispatchNode.files_shared as s}<li><code>{s.path}</code> {s.assessment}</li>{:else}<li class="muted">(none)</li>{/each}</ul>
          </div>
          <div>
            <span class="muted">Forbidden</span>
            <ul class="detail-list">{#each dispatchNode.files_forbidden as p}<li>{p}</li>{:else}<li class="muted">(none)</li>{/each}</ul>
          </div>
        </div>
      </div>
    {/if}

    <!-- Safety -->
    <div class="detail-card">
      <div class="detail-card-hdr"><h3>SAFETY</h3></div>
      {#each dispatchNode.safety_checks as check}
        <div class="check-row {check.status}">
          <strong>{check.code}</strong>: {check.message}
        </div>
      {/each}
    </div>

    <!-- Assumptions -->
    {#if assumptions?.length}
      <div class="detail-card">
        <div class="detail-card-hdr"><h3>ASSUMPTIONS</h3></div>
        <ul class="detail-list">{#each assumptions as a}<li>{a}</li>{/each}</ul>
        {#if validationPolicy?.max_concurrent_node_heavy_tasks}
          <p class="muted">Concurrency cap: {validationPolicy.max_concurrent_node_heavy_tasks}</p>
        {/if}
      </div>
    {/if}

  {:else}
    <div class="detail-empty muted">Select a run or dispatch candidate.</div>
  {/if}
</div>

<style>
  .detail-col {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px;
  }

  .detail-card {
    display: grid;
    gap: 6px;
    padding: 8px;
    background: var(--bg-surface, #13171f);
    border-radius: var(--radius-sm, 3px);
    font-size: 12px;
  }

  .detail-card-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
  }

  .detail-card-hdr h3 {
    margin: 0;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-secondary, #8b95a5);
    letter-spacing: 0.08em;
  }

  .detail-kv-list { display: grid; gap: 4px; }

  .detail-kv {
    display: grid;
    gap: 1px;
    font-size: 11px;
  }

  .detail-kv code {
    overflow-wrap: anywhere;
    font-size: 10.5px;
  }

  .detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  .detail-link {
    font-size: 11px;
    color: #58a6ff;
    text-decoration: none;
  }

  .detail-link:hover { text-decoration: underline; }

  .detail-list {
    margin: 0;
    padding-left: 14px;
    font-size: 11px;
  }

  .scope-lists {
    display: grid;
    gap: 6px;
    font-size: 11px;
  }

  .scope-lists code { overflow-wrap: anywhere; font-size: 10.5px; }

  .check-row {
    font-size: 11px;
    padding: 2px 0;
  }

  .check-row.fail strong { color: var(--red, #f85149); }
  .check-row.warn strong { color: var(--yellow, #d29922); }
  .check-row.pass strong { color: var(--green, #3fb950); }

  .detail-empty {
    padding: 16px 8px;
    display: grid;
    place-items: center;
    min-height: 6rem;
  }
</style>
