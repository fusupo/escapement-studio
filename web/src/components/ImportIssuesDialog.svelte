<script>
  import { modalFocus } from "../lib/modal-focus.js";

  /**
   * #281: pick untracked GitHub issues of an included repo and stage them
   * as one proposal. Nothing is written here; `onStaged` receives the
   * staged proposal, which is then reviewed like any other.
   * @type {{ workspace: ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace>, onStaged?: (proposal: any) => void }}
   */
  let { workspace, onStaged = () => {} } = $props();

  const dialog = $derived(workspace.importDialog);
  const importable = $derived(dialog.candidates.filter((candidate) => !candidate.conflict));
  const allSelected = $derived(importable.length > 0 && dialog.selected.length === importable.length);

  async function review() {
    const proposal = await workspace.stageImport();
    if (proposal) onStaged(proposal);
  }
</script>

{#if dialog.open}
  <div class="import-overlay" role="presentation" onclick={workspace.closeImportDialog}>
    <div
      class="import-card"
      role="dialog" tabindex="-1" use:modalFocus
      aria-modal="true"
      aria-labelledby="import-issues-title"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => { if (event.key === "Escape") workspace.closeImportDialog(); }}
    >
      <header class="import-header">
        <h3 id="import-issues-title">Import GitHub issues</h3>
        <button class="small" onclick={workspace.closeImportDialog} aria-label="Close import dialog">×</button>
      </header>

      <div class="import-controls">
        <label>
          Repository
          <select value={dialog.repo} onchange={(event) => workspace.selectImportRepo(event.currentTarget.value)} disabled={dialog.staging || workspace.includedRepos.length === 0}>
            {#each workspace.includedRepos as repo}
              <option value={repo}>{repo}</option>
            {/each}
          </select>
        </label>
        <button class="secondary" onclick={() => workspace.loadImportCandidates({ refresh: true })} disabled={dialog.loading || dialog.staging || !dialog.repo} title="Re-list this repository's issues on GitHub">
          {dialog.loading ? "Checking…" : "Check GitHub again"}
        </button>
      </div>

      {#if dialog.error}<div class="banner error inline-banner" role="alert">{dialog.error}</div>{/if}

      <div class="import-body">
        {#if workspace.includedRepos.length === 0 && !dialog.loading}
          <p class="import-empty">No repositories are included. Add one under Settings → Repositories.</p>
        {:else if dialog.loading && dialog.candidates.length === 0}
          <p class="import-empty">Listing open issues…</p>
        {:else if dialog.candidates.length === 0 && !dialog.error}
          <p class="import-empty">Every open issue in {dialog.repo} ({dialog.openIssues}) already has a work item.</p>
        {:else if dialog.candidates.length > 0}
          <p class="import-count">{dialog.candidates.length} of {dialog.openIssues} open issues are not in the graph.</p>
          <table class="import-table">
            <thead>
              <tr>
                <th class="col-check"><input type="checkbox" aria-label="Select all issues" checked={allSelected} disabled={importable.length === 0 || dialog.staging} onchange={(event) => workspace.toggleAllImportCandidates(event.currentTarget.checked)} /></th>
                <th>Issue</th>
                <th>Title</th>
                <th>Work item ID</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {#each dialog.candidates as candidate (candidate.issue_number)}
                <tr class:conflict={!!candidate.conflict}>
                  <td class="col-check">
                    <input type="checkbox" aria-label="Select issue #{candidate.issue_number}"
                      checked={dialog.selected.includes(candidate.issue_number)}
                      disabled={!!candidate.conflict || dialog.staging}
                      onchange={(event) => workspace.toggleImportCandidate(candidate.issue_number, event.currentTarget.checked)} />
                  </td>
                  <td><a href={candidate.issue_url} target="_blank" rel="noreferrer">#{candidate.issue_number}</a></td>
                  <td class="col-title">
                    {candidate.title}
                    {#if candidate.conflict}<span class="conflict-note">{candidate.conflict}</span>{/if}
                  </td>
                  <td><code>{candidate.derived_id}</code></td>
                  <td>{#if candidate.conflict}<span class="status-pill danger">conflict</span>{:else}<span class="status-pill">{candidate.initial_state}</span>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <footer class="import-footer">
        <span class="import-hint">Nothing is added until you approve the proposal on the next screen.</span>
        <button class="secondary" onclick={workspace.closeImportDialog} disabled={dialog.staging}>Cancel</button>
        <button onclick={review} disabled={dialog.staging || dialog.selected.length === 0}>
          {dialog.staging ? "Reading issues…" : `Review import (${dialog.selected.length})`}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .import-overlay {
    position: fixed;
    inset: 0;
    z-index: 999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.55);
  }

  .import-card {
    display: flex;
    flex-direction: column;
    width: min(860px, 100%);
    max-height: 86vh;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .import-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  .import-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .import-controls {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px 14px;
  }

  .import-controls label {
    flex: 1;
    min-width: 0;
  }

  .import-card :global(.inline-banner) {
    margin: 0 14px 8px;
  }

  .import-body {
    flex: 1 1 auto;
    min-height: 120px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0 14px 10px;
  }

  .import-empty,
  .import-count,
  .import-hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .import-empty {
    padding: 28px 0;
    text-align: center;
  }

  .import-count {
    padding-bottom: 6px;
  }

  .import-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .import-table th {
    position: sticky;
    top: 0;
    padding: 5px 8px;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-align: left;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .import-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: top;
    white-space: nowrap;
  }

  .import-table td.col-title {
    width: 100%;
    white-space: normal;
  }

  .import-table .col-check {
    width: 24px;
  }

  .import-table input {
    width: auto;
  }

  .import-table tr.conflict td {
    color: var(--text-muted);
  }

  .conflict-note {
    display: block;
    color: #fca5a5;
    font-size: 11px;
  }

  .import-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
  }

  .import-hint {
    flex: 1;
  }
</style>
