<script>
  import { onMount } from "svelte";
  import { getReconciliationReports } from "../lib/api.js";

  let reports = [];
  let loading = true;
  let refreshing = false;
  let error = "";

  async function loadReports({ quiet = false } = {}) {
    if (quiet) {
      refreshing = true;
    } else {
      loading = true;
    }
    error = "";

    try {
      const result = await getReconciliationReports();
      reports = Array.isArray(result) ? result : [result];
    } catch (loadError) {
      error = loadError.message;
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  onMount(() => {
    loadReports();
  });
</script>

<section class="card reconciliation-panel">
  <div class="panel-header execution-header">
    <div>
      <h2>Reconciliation</h2>
      <p class="muted">Compare predicted scope to actual execution output and inspect drift patterns.</p>
    </div>
    <div class="status-cluster">
      <button class="secondary" on:click={() => loadReports({ quiet: true })} disabled={loading || refreshing}>
        {refreshing ? 'Refreshing...' : 'Refresh reconciliation'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="banner error">{error}</div>
  {/if}

  {#if loading}
    <div class="empty-state">Loading reconciliation reports…</div>
  {:else if reports.length === 0}
    <div class="empty-state">No reconciliation reports yet. Complete an execution run to populate actual file data.</div>
  {:else}
    <div class="reconciliation-report-list">
      {#each reports as report}
        <article class="dispatch-group-card reconciliation-report-card">
          <div class="dispatch-group-header">
            <div>
              <h3>{report.work_item_id}</h3>
              <p class="muted">{report.work_item_name}</p>
            </div>
            <div class="reconciliation-stat-pills">
              <span class="status-pill healthy">matched {report.stats.matched_count}</span>
              <span class="status-pill">missed {report.stats.missed_count}</span>
              <span class="status-pill">unpredicted {report.stats.unpredicted_count}</span>
            </div>
          </div>

          {#if report.latest_run}
            <p class="muted small-text">
              Latest run: <code>{report.latest_run.run_id}</code>
              {#if report.latest_run.completed_at} · {new Date(report.latest_run.completed_at).toLocaleString()}{/if}
            </p>
            <p class="muted small-text">Artifacts: <code>{report.latest_run.artifact_dir}</code></p>
          {/if}

          {#if report.drift_patterns?.length}
            <ul class="reconciliation-drift-list">
              {#each report.drift_patterns as pattern}
                <li>
                  <strong>{pattern.kind}</strong>
                  <span>{pattern.summary}</span>
                </li>
              {/each}
            </ul>
          {/if}

          <div class="dispatch-scope-grid reconciliation-grid">
            <div>
              <div class="muted">Matched files</div>
              <ul>
                {#if report.comparison.matched_files.length}
                  {#each report.comparison.matched_files as file}<li>{file}</li>{/each}
                {:else}
                  <li>(none)</li>
                {/if}
              </ul>
            </div>
            <div>
              <div class="muted">Missed predicted files</div>
              <ul>
                {#if report.comparison.missed_predicted_files.length}
                  {#each report.comparison.missed_predicted_files as file}<li>{file}</li>{/each}
                {:else}
                  <li>(none)</li>
                {/if}
              </ul>
            </div>
            <div>
              <div class="muted">Unpredicted actual files</div>
              <ul>
                {#if report.comparison.unpredicted_actual_files.length}
                  {#each report.comparison.unpredicted_actual_files as file}<li>{file}</li>{/each}
                {:else}
                  <li>(none)</li>
                {/if}
              </ul>
            </div>
          </div>

          {#if report.overlap_candidates?.length}
            <details>
              <summary>Overlap candidates</summary>
              <ul class="subagent-findings">
                {#each report.overlap_candidates as overlap}
                  <li>
                    <code>{overlap.file}</code>
                    <div>Also predicted by: {overlap.overlapping_work_item_ids.join(', ')}</div>
                  </li>
                {/each}
              </ul>
            </details>
          {/if}

          {#if report.issue_url}
            <p><a href={report.issue_url} target="_blank" rel="noreferrer">Open linked issue</a></p>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>
