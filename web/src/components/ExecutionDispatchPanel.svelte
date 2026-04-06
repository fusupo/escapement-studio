<script>
  import { onMount } from "svelte";
  import { getExecutionPreview, launchExecutionRun, listExecutionRuns } from "../lib/api.js";

  let preview = null;
  let runs = [];
  let loading = true;
  let refreshing = false;
  let connected = false;
  let error = "";
  let stream;
  let launchingIds = [];

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
      stream?.close();
    };
  });
</script>

<section class="card execution-panel">
  <div class="panel-header execution-header">
    <div>
      <h2>Execution dispatch</h2>
      <p class="muted">Preview dispatchable work, launch isolated execution runs, and watch recent run state.</p>
    </div>
    <div class="status-cluster">
      <span class:healthy={connected} class="status-pill">{connected ? "Execution stream connected" : "Execution stream reconnecting"}</span>
      <button class="secondary" on:click={() => loadData({ quiet: true })} disabled={refreshing || loading}>{refreshing ? "Refreshing..." : "Refresh dispatch"}</button>
    </div>
  </div>

  {#if error}
    <div class="banner error">{error}</div>
  {/if}

  {#if loading}
    <div class="empty-state">Loading execution dispatch preview…</div>
  {:else if !preview}
    <div class="empty-state">Execution preview unavailable.</div>
  {:else}
    <div class="execution-summary-grid">
      <div class="execution-summary-card">
        <strong>Dispatchable now</strong>
        <span>{preview.summary.dispatchable_now}</span>
      </div>
      <div class="execution-summary-card">
        <strong>Blocked</strong>
        <span>{preview.summary.blocked_count}</span>
      </div>
      <div class="execution-summary-card">
        <strong>Parallel groups</strong>
        <span>{preview.groups.length}</span>
      </div>
      <div class="execution-summary-card">
        <strong>Max concurrent heavy tasks</strong>
        <span>{preview.validation_policy.max_concurrent_node_heavy_tasks}</span>
      </div>
    </div>

    {#if preview.assumptions?.length}
      <details class="execution-assumptions">
        <summary>Dispatch assumptions</summary>
        <ul>
          {#each preview.assumptions as assumption}
            <li>{assumption}</li>
          {/each}
        </ul>
      </details>
    {/if}

    <div class="execution-groups">
      {#if preview.groups.length === 0}
        <p class="muted">No dispatchable execution groups yet.</p>
      {/if}

      {#each preview.groups as group}
        <section class="dispatch-group-card">
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
              <article class="dispatch-node-card">
                <div class="dispatch-node-header">
                  <div>
                    <strong>{node.id}</strong>
                    <div>{node.name}</div>
                  </div>
                  <button on:click={() => launchNode(node)} disabled={!node.can_launch || launchingIds.includes(node.id)}>
                    {launchingIds.includes(node.id) ? "Launching..." : node.can_launch ? "Launch" : "Blocked"}
                  </button>
                </div>

                <div class="muted small-text">{node.branch} from {node.default_base_ref} · {node.worktree_path}</div>
                {#if node.scope_hint}
                  <p>{node.scope_hint}</p>
                {/if}

                <details>
                  <summary>Scope and safety</summary>
                  <div class="dispatch-scope-grid">
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

    <section class="dispatch-group-card">
      <div class="dispatch-group-header">
        <div>
          <h3>Recent execution runs</h3>
          <p class="muted">Status snapshots persist under the external artifact root.</p>
        </div>
      </div>

      {#if runs.length === 0}
        <p class="muted">No execution runs launched yet.</p>
      {:else}
        <div class="dispatch-node-list">
          {#each runs as run}
            <article class="dispatch-node-card execution-run-card">
              <div class="dispatch-node-header">
                <div>
                  <strong>{run.work_item_id}</strong>
                  <div>{run.work_item_name}</div>
                </div>
                <span class="proposal-type">{run.status}</span>
              </div>
              <div class="muted small-text">{run.branch} from {run.base_ref} · {run.worktree_path}</div>
              <div class="muted small-text">Artifacts: {run.artifact_dir}</div>
              {#if run.progress_message}
                <p>{run.progress_message}</p>
              {/if}
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
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</section>
