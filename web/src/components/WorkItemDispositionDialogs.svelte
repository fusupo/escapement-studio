<script>
  import { modalFocus } from "../lib/modal-focus.js";

/** @type {ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace>} */
export let workspace;
</script>
{#if workspace.cancelDialog}
      <div class="plan-review-overlay" role="presentation" on:click={workspace.closeCancelDialog}>
        <div
          class="plan-review-card delete-dialog"
          role="dialog" tabindex="-1" use:modalFocus
          aria-modal="true"
          aria-labelledby="cancel-work-item-title"
          on:click|stopPropagation
          on:keydown={workspace.handleGlobalKeydown}
        >
          <header class="plan-review-header">
            <h3 id="cancel-work-item-title">Cancel {workspace.cancelDialog.item.id}</h3>
            <button class="small" on:click={workspace.closeCancelDialog} disabled={workspace.cancelDialog.submitting} aria-label="Close cancel dialog">×</button>
          </header>

          <div class="delete-dialog-body">
            <p><strong>Cancel preserves the Studio node and history.</strong> This closes GitHub issue #{workspace.cancelDialog.item.issue_number} in {workspace.cancelDialog.item.repo}, archives any plan artifacts, and marks the work item <code>cancelled</code>.</p>
            <label>
              <span class="muted">Optional cancellation note</span>
              <textarea
                rows="4"
                bind:value={workspace.cancelDialog.cancelNote}
                placeholder="Optional note posted to the GitHub issue before it is closed."
                disabled={workspace.cancelDialog.submitting}
              ></textarea>
            </label>
            <label class="checkbox-row">
              <input
                type="checkbox"
                checked={workspace.cancelDialog.confirmCancel}
                on:change={(event) => workspace.cancelDialog = { ...workspace.cancelDialog, confirmCancel: event.currentTarget.checked }}
              />
              <span>I approve cancelling this work item and closing its GitHub issue.</span>
            </label>
          </div>

          <footer class="delete-dialog-actions">
            <button class="small" on:click={workspace.closeCancelDialog} disabled={workspace.cancelDialog.submitting}>Keep work item active</button>
            <button
              class="small"
              on:click={workspace.confirmCancelWorkItem}
              disabled={!workspace.cancelDialog.confirmCancel || workspace.cancelDialog.submitting}
            >
              {workspace.cancelDialog.submitting ? "Cancelling…" : "Cancel work item"}
            </button>
          </footer>
        </div>
      </div>
    {/if}

    {#if workspace.deleteDialog}
      <div class="plan-review-overlay" role="presentation" on:click={workspace.closeDeleteDialog}>
        <div
          class="plan-review-card delete-dialog"
          role="dialog" tabindex="-1" use:modalFocus
          aria-modal="true"
          aria-labelledby="delete-work-item-title"
          on:click|stopPropagation
          on:keydown={workspace.handleGlobalKeydown}
        >
          <header class="plan-review-header">
            <h3 id="delete-work-item-title">Delete {workspace.deleteDialog.item.id}</h3>
            <button class="small" on:click={workspace.closeDeleteDialog} disabled={workspace.deleteDialog.submitting} aria-label="Close delete dialog">×</button>
          </header>

          <div class="delete-dialog-body">
            <p><strong>This permanently removes the Studio graph node.</strong> Delete is different from cancel and should only be used for junk, accidental, duplicate, or malformed work items.</p>
            <p>The backend will try to delete GitHub issue #{workspace.deleteDialog.item.issue_number} in {workspace.deleteDialog.item.repo} first, then remove the Studio node and any acknowledged connected edges.</p>

            {#if workspace.deleteDialog.connectedEdges.length > 0}
              <div class="banner warn">
                This work item has {workspace.deleteDialog.connectedEdges.length} connected edge{workspace.deleteDialog.connectedEdges.length === 1 ? "" : "s"}. Deleting it will also remove those graph relationships.
              </div>
              <ul class="delete-edge-list">
                {#each workspace.deleteDialog.connectedEdges as edge}
                  <li><code>{edge.from_id}</code> {edge.rel} <code>{edge.to_id}</code></li>
                {/each}
              </ul>
            {/if}

            <label class="checkbox-row">
              <input
                type="checkbox"
                checked={workspace.deleteDialog.acknowledgeDelete}
                on:change={(event) => workspace.deleteDialog = { ...workspace.deleteDialog, acknowledgeDelete: event.currentTarget.checked }}
              />
              <span>I understand this is destructive and is not the normal replacement for cancel.</span>
            </label>

            {#if workspace.deleteDialog.connectedEdges.length > 0}
              <label class="checkbox-row">
                <input
                  type="checkbox"
                  checked={workspace.deleteDialog.acknowledgeConnectedEdges}
                  on:change={(event) => workspace.deleteDialog = { ...workspace.deleteDialog, acknowledgeConnectedEdges: event.currentTarget.checked }}
                />
                <span>I approve removing all connected edges shown above.</span>
              </label>
            {/if}

            <label class="checkbox-row">
              <input
                type="checkbox"
                checked={workspace.deleteDialog.acknowledgeFallback}
                on:change={(event) => workspace.deleteDialog = { ...workspace.deleteDialog, acknowledgeFallback: event.currentTarget.checked }}
              />
              <span>If GitHub issue deletion is unavailable, still delete the Studio node and show me the fallback warning.</span>
            </label>
          </div>

          <footer class="delete-dialog-actions">
            <button class="small" on:click={workspace.closeDeleteDialog} disabled={workspace.deleteDialog.submitting}>Keep work item</button>
            <button
              class="danger"
              on:click={workspace.confirmDeleteWorkItem}
              disabled={!workspace.deleteDialog.acknowledgeDelete || !workspace.deleteDialog.acknowledgeConnectedEdges || !workspace.deleteDialog.acknowledgeFallback || workspace.deleteDialog.submitting}
            >
              {workspace.deleteDialog.submitting ? "Deleting…" : "Delete permanently"}
            </button>
          </footer>
        </div>
      </div>
    {/if}

<style>
  .banner.warn {
    background: rgba(217, 119, 6, 0.14);
    border: 1px solid rgba(251, 191, 36, 0.28);
    color: #fde68a;
  }

  .delete-dialog {
    max-width: 640px;
  }

  .delete-dialog-body {
    display: grid;
    gap: 12px;
  }

  .checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13px;
    color: #cbd5e1;
  }

  .checkbox-row input {
    margin-top: 2px;
  }

  .delete-edge-list {
    margin: 0;
    padding-left: 18px;
    color: #cbd5e1;
    font-size: 13px;
  }

  .delete-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
  }
</style>
