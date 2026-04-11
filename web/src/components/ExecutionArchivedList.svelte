<script>
  import { getArchivedExecutionRunBundle } from "../lib/api.js";
  import { renderMarkdown } from "../lib/markdown.js";

  export let bundles = [];
  export let loading = false;
  export let error = "";
  export let onCopy = async (_value, _message) => {};

  let detailsByWorkItem = {};
  let detailLoading = {};
  let detailErrors = {};

  async function ensureDetailLoaded(bundle) {
    if (!bundle?.work_item_id) return;
    if (Object.prototype.hasOwnProperty.call(detailsByWorkItem, bundle.work_item_id)) return;
    detailLoading = { ...detailLoading, [bundle.work_item_id]: true };
    detailErrors = { ...detailErrors, [bundle.work_item_id]: "" };
    try {
      const detail = await getArchivedExecutionRunBundle(bundle.work_item_id);
      detailsByWorkItem = { ...detailsByWorkItem, [bundle.work_item_id]: detail };
    } catch (e) {
      detailErrors = { ...detailErrors, [bundle.work_item_id]: e.message };
    } finally {
      detailLoading = { ...detailLoading, [bundle.work_item_id]: false };
    }
  }

  function formatTimestamp(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); } catch { return value; }
  }

  function prLabel(pullRequest) {
    if (!pullRequest?.number) return "PR";
    const suffix = pullRequest.state ? ` · ${String(pullRequest.state).toLowerCase()}` : "";
    return `PR #${pullRequest.number}${suffix}`;
  }
</script>

<div class="archived-list-root">
  {#if loading}
    <div class="workspace-empty muted">Loading archived bundles...</div>
  {:else if error}
    <div class="workspace-empty muted">{error}</div>
  {:else if bundles.length === 0}
    <div class="workspace-empty muted">No archived bundles yet.</div>
  {:else}
    <div class="archived-bundles">
      {#each bundles as bundle}
        <details class="workspace-expandable archived-bundle" on:toggle={(e) => e.currentTarget.open && ensureDetailLoaded(bundle)}>
          <summary>
            <span class="archived-summary-main">
              <span class="archived-title">{bundle.work_item_id} — {bundle.work_item_name}</span>
              <span class="archived-subtitle">{formatTimestamp(bundle.archived_at)}</span>
            </span>
            <span class="archived-summary-side">
              <span class="status-pill">{bundle.runs.length} run{bundle.runs.length === 1 ? "" : "s"}</span>
            </span>
          </summary>

          <div class="archived-body">
            <div class="feed-pinned-card archived-meta">
              <div class="archived-meta-row">
                <span class="muted">Archive path</span>
                <code>{bundle.archive_path}</code>
                <button class="secondary small" on:click={() => onCopy(bundle.archive_path, `Copied archive path for ${bundle.work_item_id}`)}>Copy</button>
              </div>
              <div class="archived-meta-row">
                <span class="muted">Archived</span>
                <span>{formatTimestamp(bundle.archived_at)}</span>
              </div>
              {#if bundle.pull_request?.url}
                <div class="archived-meta-row">
                  <span class="muted">Pull request</span>
                  <a class="detail-link" href={bundle.pull_request.url} target="_blank" rel="noreferrer">{prLabel(bundle.pull_request)}</a>
                  {#if bundle.pull_request.merged_at}
                    <span class="muted">merged {formatTimestamp(bundle.pull_request.merged_at)}</span>
                  {/if}
                </div>
              {/if}
              {#if bundle.plan_artifacts}
                <div class="archived-meta-row plan-artifacts">
                  <span class="muted">Plan artifacts</span>
                  <span>{bundle.plan_artifacts.scratchpad_filename || ""}{bundle.plan_artifacts.scratchpad_filename && bundle.plan_artifacts.metadata_filename ? " · " : ""}{bundle.plan_artifacts.metadata_filename || ""}</span>
                </div>
              {/if}
            </div>

            <section class="workspace-section">
              <div class="workspace-section-hdr">
                <h4>Archived runs</h4>
                <span class="muted">{bundle.runs.length}</span>
              </div>
              {#if bundle.runs.length > 0}
                <div class="archived-runs-table">
                  {#each bundle.runs as run}
                    <div class="archived-run-row">
                      <div class="archived-run-title-row">
                        <strong>{run.run_id}</strong>
                        <span class="status-pill">{run.status}</span>
                      </div>
                      <div class="archived-run-meta">
                        <span><span class="muted">branch</span> <code>{run.branch}</code></span>
                        <span><span class="muted">base</span> <code>{run.base_ref}</code></span>
                        <span><span class="muted">completed</span> {formatTimestamp(run.completed_at || run.created_at)}</span>
                        <span><span class="muted">changed files</span> {run.changed_file_count}</span>
                      </div>
                      {#if run.result_summary}
                        <div class="archived-run-summary">{run.result_summary}</div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="workspace-empty muted">This archive contains no run snapshots.</div>
              {/if}
            </section>

            <section class="workspace-section">
              <div class="workspace-section-hdr"><h4>README</h4></div>
              {#if detailLoading[bundle.work_item_id]}
                <div class="workspace-empty muted">Loading README...</div>
              {:else if detailErrors[bundle.work_item_id]}
                <div class="workspace-empty muted">{detailErrors[bundle.work_item_id]}</div>
              {:else if detailsByWorkItem[bundle.work_item_id]?.readme_content}
                <div class="scratchpad-rendered archived-readme">{@html renderMarkdown(detailsByWorkItem[bundle.work_item_id].readme_content)}</div>
              {:else}
                <div class="workspace-empty muted">No README available.</div>
              {/if}
            </section>
          </div>
        </details>
      {/each}
    </div>
  {/if}
</div>

<style>
  .archived-list-root,
  .archived-bundles {
    display: grid;
    gap: 8px;
  }

  .archived-bundle summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    list-style: none;
  }

  .archived-bundle summary::-webkit-details-marker {
    display: none;
  }

  .archived-summary-main {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .archived-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .archived-subtitle {
    font-size: 11px;
    color: var(--text-muted, #566070);
  }

  .archived-body {
    display: grid;
    gap: 8px;
    margin-top: 8px;
  }

  .feed-pinned-card {
    padding: 8px;
    border: 1px solid var(--border, #2b3245);
    border-radius: var(--radius-sm, 3px);
    background: var(--bg-base, #0d1117);
  }

  .archived-meta {
    display: grid;
    gap: 6px;
  }

  .archived-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 12px;
  }

  .archived-meta-row code {
    overflow-wrap: anywhere;
  }

  .archived-runs-table {
    display: grid;
    gap: 8px;
  }

  .archived-run-row {
    display: grid;
    gap: 4px;
    padding: 8px;
    border: 1px solid var(--border, #2b3245);
    border-radius: var(--radius-sm, 3px);
    background: var(--bg-base, #0d1117);
  }

  .archived-run-title-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: center;
  }

  .archived-run-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11px;
  }

  .archived-run-summary {
    font-size: 12px;
    white-space: pre-wrap;
    color: var(--text-secondary, #8b95a5);
  }

  .archived-readme {
    padding-top: 4px;
  }

  .archived-readme :global(h1),
  .archived-readme :global(h2),
  .archived-readme :global(h3) {
    margin: 6px 0 4px;
  }

  .archived-readme :global(ul),
  .archived-readme :global(ol) {
    padding-left: 16px;
  }
</style>
