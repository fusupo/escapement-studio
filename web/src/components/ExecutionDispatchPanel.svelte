<script>
  import { onMount } from "svelte";
  import { getExecutionPreview, launchExecutionRun, listExecutionRuns } from "../lib/api.js";

  let preview = null;
  let runs = [];
  let loading = true;
  let refreshing = false;
  let connected = false;
  let error = "";
  let copiedMessage = "";
  let copyTimer;
  let stream;
  let launchingIds = [];

  $: activeRuns = runs.filter((run) => ["queued", "preparing", "running"].includes(run.status));
  $: completedRuns = runs.filter((run) => run.status === "completed");
  $: blockedRuns = runs.filter((run) => run.status === "blocked");
  $: failedRuns = runs.filter((run) => run.status === "error");

  function mergeRun(run) {
    if (!run) {
      return;
    }

    const existingIndex = runs.findIndex((item) => item.run_id === run.run_id);
    if (existingIndex >= 0) {
      runs = runs.map((item, index) => (index === existingIndex ? run : item));
      return;
    }

    runs = [run, ...runs].slice(0, 16);
  }

  function formatTimestamp(value) {
    if (!value) {
      return "—";
    }

    return new Date(value).toLocaleString();
  }

  function formatSafetySummary(checks = []) {
    const failed = checks.filter((check) => check.status === "fail").length;
    const warned = checks.filter((check) => check.status === "warn").length;

    if (failed > 0) {
      return `${failed} blocking check${failed === 1 ? "" : "s"}`;
    }

    if (warned > 0) {
      return `${warned} warning${warned === 1 ? "" : "s"}`;
    }

    return "All safety checks passed";
  }

  function runStatusTone(status) {
    if (status === "completed") {
      return "healthy";
    }

    if (status === "running" || status === "preparing" || status === "queued") {
      return "info";
    }

    if (status === "blocked") {
      return "warn";
    }

    if (status === "error") {
      return "danger";
    }

    return "";
  }

  async function copyValue(value, message) {
    if (!value || !window?.navigator?.clipboard) {
      copiedMessage = "Clipboard unavailable in this browser.";
      return;
    }

    try {
      await window.navigator.clipboard.writeText(value);
      copiedMessage = message;
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        copiedMessage = "";
      }, 2000);
    } catch (copyError) {
      copiedMessage = copyError.message;
    }
  }

  function buildPrCommand(run) {
    return `gh pr create --base ${run.base_ref} --head ${run.branch}`;
  }

  async function loadData({ quiet = false } = {}) {
    if (quiet) {
      refreshing = true;
    } else {
      loading = true;
    }
    error = "";

    try {
      const [nextPreview, nextRuns] = await Promise.all([getExecutionPreview(), listExecutionRuns()]);
      preview = nextPreview;
      runs = nextRuns;
    } catch (loadError) {
      error = loadError.message;
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function launchNode(node) {
    launchingIds = [...launchingIds, node.id];
    error = "";

    try {
      const result = await launchExecutionRun({ work_item_id: node.id });
      mergeRun(result.run);
      await loadData({ quiet: true });
    } catch (launchError) {
      error = launchError.message;
    } finally {
      launchingIds = launchingIds.filter((id) => id !== node.id);
    }
  }

  onMount(() => {
    loadData();

    stream = new EventSource("/api/execution/stream");
    stream.addEventListener("open", () => {
      connected = true;
    });
    stream.addEventListener("error", () => {
      connected = false;
    });

    const handleEnvelope = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        mergeRun(envelope.payload?.run);
      } catch (streamError) {
        console.error("Failed to parse execution SSE event", streamError);
      }
    };

    stream.addEventListener("execution_status", handleEnvelope);
    stream.addEventListener("execution_result", handleEnvelope);

    return () => {
      window.clearTimeout(copyTimer);
      stream?.close();
    };
  });
</script>

<section class="card execution-panel">
  <div class="panel-header execution-header">
    <div>
      <h2>Execute workspace</h2>
      <p class="muted">Launch dispatchable work, track live runs, inspect worktree and branch context, and prep PR or sync follow-up without leaving this view.</p>
    </div>
    <div class="status-cluster execution-toolbar">
      <span class:healthy={connected} class="status-pill">{connected ? "Execution stream connected" : "Execution stream reconnecting"}</span>
      <button class="secondary" on:click={() => loadData({ quiet: true })} disabled={refreshing || loading}>{refreshing ? "Refreshing..." : "Refresh execute view"}</button>
    </div>
  </div>

  {#if copiedMessage}
    <div class="banner success inline-banner" aria-live="polite">{copiedMessage}</div>
  {/if}

  {#if error}
    <div class="banner error inline-banner">{error}</div>
  {/if}

  {#if loading}
    <div class="empty-state">Loading execution dispatch preview…</div>
  {:else if !preview}
    <div class="empty-state">Execution preview unavailable.</div>
  {:else}
    <div class="execution-summary-grid execute-summary-grid">
      <div class="execution-summary-card">
        <strong>Dispatchable now</strong>
        <span>{preview.summary.dispatchable_now}</span>
      </div>
      <div class="execution-summary-card">
        <strong>Active runs</strong>
        <span>{activeRuns.length}</span>
      </div>
      <div class="execution-summary-card">
        <strong>Completed runs</strong>
        <span>{completedRuns.length}</span>
      </div>
      <div class="execution-summary-card">
        <strong>Blocked / failed</strong>
        <span>{blockedRuns.length + failedRuns.length}</span>
      </div>
    </div>

    <div class="execute-layout">
      <div class="execute-primary-column">
        {#if preview.assumptions?.length}
          <details class="execution-assumptions dispatch-group-card">
            <summary>Dispatch assumptions and limits</summary>
            <ul>
              {#each preview.assumptions as assumption}
                <li>{assumption}</li>
              {/each}
            </ul>
            <p class="muted small-text execution-policy-note">
              Heavy task concurrency cap: {preview.validation_policy.max_concurrent_node_heavy_tasks}
            </p>
          </details>
        {/if}

        <section class="dispatch-group-card">
          <div class="dispatch-group-header">
            <div>
              <h3>Dispatch queue</h3>
              <p class="muted">Review launchable work, owned scope, and worktree safety before starting a run.</p>
            </div>
            <span class="proposal-type">{preview.groups.length} group(s)</span>
          </div>

          {#if preview.groups.length === 0}
            <p class="muted">No dispatchable execution groups yet.</p>
          {:else}
            <div class="execution-groups">
              {#each preview.groups as group}
                <section class="dispatch-group-card dispatch-subgroup">
                  <div class="dispatch-group-header">
                    <div>
                      <h3>{group.group_id}</h3>
                      <p class="muted">Repo: {group.repo} · {group.nodes.length} launchable node(s)</p>
                    </div>
                    {#if group.merge_order?.length}
                      <span class="proposal-type">Merge order: {group.merge_order.join(" → ")}</span>
                    {/if}
                  </div>

                  <div class="dispatch-node-list">
                    {#each group.nodes as node}
                      <article class="dispatch-node-card execute-node-card">
                        <div class="dispatch-node-header">
                          <div>
                            <strong>{node.id}</strong>
                            <div>{node.name}</div>
                          </div>
                          <div class="node-action-cluster">
                            {#if node.issue_url}
                              <a class="ghost-link small" href={node.issue_url} target="_blank" rel="noreferrer">Open issue</a>
                            {/if}
                            <button on:click={() => launchNode(node)} disabled={!node.can_launch || launchingIds.includes(node.id)}>
                              {launchingIds.includes(node.id) ? "Launching..." : node.can_launch ? "Launch run" : "Blocked"}
                            </button>
                          </div>
                        </div>

                        <div class="execution-context-row">
                          <span class="context-chip"><span class="context-label">Branch</span><code>{node.branch}</code></span>
                          <span class="context-chip"><span class="context-label">Base</span><code>{node.default_base_ref}</code></span>
                          <span class="context-chip context-path"><span class="context-label">Worktree</span><code>{node.worktree_path}</code></span>
                        </div>

                        <div class="execute-card-actions">
                          <button class="secondary small" on:click={() => copyValue(node.branch, `Copied branch ${node.branch}`)}>Copy branch</button>
                          <button class="secondary small" on:click={() => copyValue(node.worktree_path, `Copied worktree for ${node.id}`)}>Copy worktree</button>
                        </div>

                        <div class="safety-summary-row">
                          <span class="status-pill {node.can_launch ? 'healthy' : 'warn'}">{node.can_launch ? 'Launchable' : 'Blocked by safety checks'}</span>
                          <span class="muted small-text">{formatSafetySummary(node.safety_checks)}</span>
                        </div>

                        {#if node.scope_hint}
                          <p>{node.scope_hint}</p>
                        {/if}

                        <details>
                          <summary>Scope, sharing, and safety</summary>
                          <div class="dispatch-scope-grid execute-scope-grid">
                            <div>
                              <div class="muted">Owned files</div>
                              <ul>
                                {#if node.files_owned.length}
                                  {#each node.files_owned as path}<li>{path}</li>{/each}
                                {:else}
                                  <li>(none predicted)</li>
                                {/if}
                              </ul>
                            </div>
                            <div>
                              <div class="muted">Shared files</div>
                              <ul>
                                {#if node.files_shared.length}
                                  {#each node.files_shared as shared}<li><code>{shared.path}</code> — {shared.assessment}</li>{/each}
                                {:else}
                                  <li>(none)</li>
                                {/if}
                              </ul>
                            </div>
                            <div>
                              <div class="muted">Forbidden files</div>
                              <ul>
                                {#if node.files_forbidden.length}
                                  {#each node.files_forbidden as path}<li>{path}</li>{/each}
                                {:else}
                                  <li>(none)</li>
                                {/if}
                              </ul>
                            </div>
                          </div>
                          <div class="execution-check-list">
                            {#each node.safety_checks as check}
                              <div class="execution-check {check.status}">
                                <strong>{check.code}</strong>
                                <span>{check.message}</span>
                              </div>
                            {/each}
                          </div>
                        </details>
                      </article>
                    {/each}
                  </div>
                </section>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <aside class="execute-sidebar-column">
        <section class="dispatch-group-card execute-sidebar-card">
          <div class="dispatch-group-header">
            <div>
              <h3>Run status</h3>
              <p class="muted">Live execution state and handoff actions for recent runs.</p>
            </div>
            <span class="status-pill {connected ? 'healthy' : 'warn'}">{connected ? 'Live' : 'Retrying stream'}</span>
          </div>

          <div class="run-stat-grid">
            <div class="execution-summary-card compact-stat">
              <strong>Queued / active</strong>
              <span>{activeRuns.length}</span>
            </div>
            <div class="execution-summary-card compact-stat">
              <strong>Completed</strong>
              <span>{completedRuns.length}</span>
            </div>
            <div class="execution-summary-card compact-stat">
              <strong>Blocked</strong>
              <span>{blockedRuns.length}</span>
            </div>
            <div class="execution-summary-card compact-stat">
              <strong>Errors</strong>
              <span>{failedRuns.length}</span>
            </div>
          </div>
        </section>

        <section class="dispatch-group-card execute-sidebar-card">
          <div class="dispatch-group-header">
            <div>
              <h3>Recent execution runs</h3>
              <p class="muted">Use branch, worktree, and artifact context to review work before PR or sync follow-up.</p>
            </div>
          </div>

          {#if runs.length === 0}
            <p class="muted">No execution runs launched yet.</p>
          {:else}
            <div class="dispatch-node-list run-list">
              {#each runs as run}
                <article class="dispatch-node-card execution-run-card">
                  <div class="dispatch-node-header">
                    <div>
                      <strong>{run.work_item_id}</strong>
                      <div>{run.work_item_name}</div>
                    </div>
                    <span class="status-pill {runStatusTone(run.status)}">{run.status}</span>
                  </div>

                  <div class="execution-context-row run-context-row">
                    <span class="context-chip"><span class="context-label">Branch</span><code>{run.branch}</code></span>
                    <span class="context-chip"><span class="context-label">Base</span><code>{run.base_ref}</code></span>
                  </div>
                  <div class="execution-context-row run-context-row">
                    <span class="context-chip context-path"><span class="context-label">Worktree</span><code>{run.worktree_path}</code></span>
                  </div>
                  <div class="execution-context-row run-context-row">
                    <span class="context-chip context-path"><span class="context-label">Artifacts</span><code>{run.artifact_dir}</code></span>
                  </div>

                  <div class="run-timestamp-grid small-text muted">
                    <span>Created: {formatTimestamp(run.created_at)}</span>
                    <span>Updated: {formatTimestamp(run.updated_at)}</span>
                    {#if run.started_at}<span>Started: {formatTimestamp(run.started_at)}</span>{/if}
                    {#if run.completed_at}<span>Completed: {formatTimestamp(run.completed_at)}</span>{/if}
                  </div>

                  <div class="safety-summary-row">
                    <span class="muted small-text">{formatSafetySummary(run.safety_checks)}</span>
                  </div>

                  {#if run.progress_message}
                    <p>{run.progress_message}</p>
                  {/if}

                  <div class="execute-card-actions">
                    {#if run.issue_url}
                      <a class="ghost-link small" href={run.issue_url} target="_blank" rel="noreferrer">Open issue</a>
                    {/if}
                    <button class="secondary small" on:click={() => copyValue(run.branch, `Copied branch ${run.branch}`)}>Copy branch</button>
                    <button class="secondary small" on:click={() => copyValue(run.worktree_path, `Copied worktree for ${run.work_item_id}`)}>Copy worktree</button>
                    {#if run.status === "completed"}
                      <button class="secondary small" on:click={() => copyValue(buildPrCommand(run), `Copied PR command for ${run.work_item_id}`)}>Copy PR command</button>
                      <a class="ghost-link small" href="#reconciliation-panel">Review reconciliation</a>
                    {/if}
                  </div>

                  {#if run.result_summary}
                    <details>
                      <summary>Result summary</summary>
                      <pre>{run.result_summary}</pre>
                    </details>
                  {/if}

                  {#if run.changed_files?.length}
                    <details>
                      <summary>Changed files</summary>
                      <ul>
                        {#each run.changed_files as path}<li>{path}</li>{/each}
                      </ul>
                    </details>
                  {/if}

                  {#if run.errors?.length}
                    <details>
                      <summary>Errors</summary>
                      <ul>
                        {#each run.errors as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}
                      </ul>
                    </details>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </section>
      </aside>
    </div>
  {/if}
</section>

<style>
  .execution-toolbar {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .execute-summary-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .execute-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(360px, 0.95fr);
    gap: 1rem;
    align-items: start;
  }

  .execute-primary-column,
  .execute-sidebar-column {
    display: grid;
    gap: 1rem;
  }

  .execute-sidebar-column {
    position: sticky;
    top: 1rem;
  }

  .dispatch-subgroup {
    padding: 0.85rem;
    background: rgba(15, 23, 42, 0.35);
  }

  .execute-node-card,
  .execution-run-card,
  .execute-sidebar-card {
    background: rgba(2, 6, 23, 0.58);
  }

  .node-action-cluster,
  .execute-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .execution-context-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .context-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    max-width: 100%;
    padding: 0.45rem 0.65rem;
    border-radius: 999px;
    background: rgba(30, 41, 59, 0.9);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: #dbeafe;
    overflow: hidden;
  }

  .context-chip code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-path {
    max-width: 100%;
  }

  .context-label {
    color: #93c5fd;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .safety-summary-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .execute-scope-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .run-stat-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .compact-stat {
    min-height: 0;
  }

  .run-list {
    max-height: calc(100vh - 18rem);
    overflow: auto;
    padding-right: 0.25rem;
  }

  .run-context-row {
    margin-top: -0.1rem;
  }

  .run-timestamp-grid {
    display: grid;
    gap: 0.2rem;
  }

  .ghost-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    padding: 0.7rem 1rem;
    text-decoration: none;
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.18);
    color: #e2e8f0;
  }

  .ghost-link.small {
    padding: 0.35rem 0.7rem;
    font-size: 0.875rem;
  }

  .status-pill.info {
    background: rgba(30, 64, 175, 0.9);
    color: #dbeafe;
  }

  .status-pill.warn {
    background: rgba(146, 64, 14, 0.9);
    color: #fde68a;
  }

  .status-pill.danger {
    background: rgba(127, 29, 29, 0.92);
    color: #fecaca;
  }

  .execution-policy-note {
    margin: 0;
  }

  @media (max-width: 1100px) {
    .execute-layout {
      grid-template-columns: 1fr;
    }

    .execute-sidebar-column {
      position: static;
    }

    .run-list {
      max-height: none;
      overflow: visible;
      padding-right: 0;
    }
  }

  @media (max-width: 820px) {
    .execute-summary-grid,
    .execute-scope-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  @media (max-width: 640px) {
    .execute-summary-grid,
    .execute-scope-grid,
    .run-stat-grid {
      grid-template-columns: 1fr;
    }

    .dispatch-node-header {
      flex-direction: column;
    }
  }
</style>
