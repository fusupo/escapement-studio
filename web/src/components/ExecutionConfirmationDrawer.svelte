<script>

import ExecutionRefinementItem from "./ExecutionRefinementItem.svelte";

import { hasCancellationSelection, refinementDraftFor, unresolvedRefinementItems } from "../lib/execution-refinement.js";

/** @type {ReturnType<typeof import("../lib/execution/workspace.svelte.js").createWorkspace>} */
export let workspace;
</script>
{#if workspace.activeSelection === "run" && workspace.selectedRun?.status === "disambiguating" && !workspace.refinementDrawerClosed[workspace.selectedRun.run_id]}
      {@const drawerRun = workspace.selectedRun}
      {@const drawerItems = drawerRun.refinement?.items || []}
      {@const drawerUnresolved = unresolvedRefinementItems(drawerRun, workspace.refinementResponses)}
      {@const drawerContext = workspace.disambiguationContext[drawerRun.run_id] || ""}
      {@const drawerResolving = !!workspace.resolvingDisambiguation[drawerRun.run_id]}
      {@const drawerAllowsUnresolved = !!workspace.confirmUnresolved[drawerRun.run_id]}
      {@const drawerCancelsExecution = hasCancellationSelection(drawerRun, workspace.refinementResponses)}

      <aside
        class="refinement-drawer"
        aria-label="Execution confirmation"
        style:width={workspace.refinementDrawerWidths[drawerRun.run_id] ? `${workspace.refinementDrawerWidths[drawerRun.run_id]}px` : null}
      >
        <button
          type="button"
          class="refinement-drawer-resize"
          aria-label="Resize execution confirmation drawer"
          on:mousedown={(event) => workspace.startRefinementDrawerResize(event, drawerRun.run_id)}
          on:keydown={(event) => workspace.handleRefinementDrawerResizeKeydown(event, drawerRun.run_id)}
        ><span></span></button>

        <header class="refinement-drawer-header">
          <div class="refinement-drawer-title">
            <span class="refinement-drawer-eyebrow">Execution confirmation</span>
            <h3>{drawerRun.work_item_id}</h3>
            <p>{drawerRun.work_item_name}</p>
          </div>
          <div class="refinement-drawer-actions">
            <span class="status-pill disambiguating">{drawerUnresolved.length} unresolved</span>
            <button
              type="button"
              class="secondary small refinement-drawer-close"
              aria-label="Close execution confirmation"
              title="Close confirmation drawer"
              on:click={() => workspace.setRefinementDrawerClosed(drawerRun.run_id, true)}
            >&times;</button>
          </div>
        </header>

        <div class="refinement-drawer-intro">
          The approved plan was checked in the isolated worktree. Answer the items below, then explicitly confirm the selected disposition. This is separate from approving the initial plan.
        </div>

        <div class="refinement-drawer-body">
          {#if drawerItems.length}
            <div class="refinement-items">
              {#each drawerItems as item, index}
                {@const draft = refinementDraftFor(drawerRun, item, workspace.refinementResponses)}
                <ExecutionRefinementItem
                  runId={drawerRun.run_id}
                  {item}
                  {index}
                  {draft}
                  disabled={drawerResolving}
                  on:draft={(event) => workspace.setRefinementResponse(drawerRun, item, event.detail)}
                />
              {/each}
            </div>
          {:else}
            <div class="refinement-clear">No open questions or blockers were found in the worktree refinement.</div>
          {/if}

          <label class="refinement-context-block">
            <span>Additional context <span class="muted">(optional)</span></span>
            <textarea
              placeholder="Anything else the coding agent should know..."
              value={drawerContext}
              on:input={(e) => workspace.disambiguationContext = { ...workspace.disambiguationContext, [drawerRun.run_id]: e.currentTarget.value }}
              rows="3"
              disabled={drawerResolving}
            ></textarea>
          </label>
        </div>

        <footer class="refinement-confirmation-footer">
          {#if drawerCancelsExecution}
            <span class="refinement-ready">The run will be abandoned and the work item returned to ready</span>
          {:else if drawerUnresolved.length > 0}
            <label class="confirm-unresolved">
              <input
                type="checkbox"
                checked={drawerAllowsUnresolved}
                on:change={(e) => workspace.confirmUnresolved = { ...workspace.confirmUnresolved, [drawerRun.run_id]: e.currentTarget.checked }}
                disabled={drawerResolving}
              />
              Proceed with {drawerUnresolved.length} unresolved {drawerUnresolved.length === 1 ? "item" : "items"}
            </label>
          {:else}
            <span class="refinement-ready">All items answered</span>
          {/if}

          <button
            class="confirm-execution-button"
            on:click={() => workspace.handleResolveDisambiguation(drawerRun)}
            disabled={drawerResolving || (!drawerCancelsExecution && drawerUnresolved.length > 0 && !drawerAllowsUnresolved)}
          >
            {drawerResolving
              ? (drawerCancelsExecution ? "Abandoning execution..." : "Starting coding...")
              : (drawerCancelsExecution ? "Abandon execution" : "Confirm execution and start coding")}
          </button>
        </footer>
      </aside>
    {/if}

<style>
  .refinement-drawer {
    position: absolute;
    z-index: 30;
    inset: 0 0 0 auto;
    width: clamp(600px, 52vw, 960px);
    min-width: 480px;
    overflow: hidden;
    background: var(--bg-panel, #0d1117);
    border-left: 1px solid rgba(163, 113, 247, 0.5);
    box-shadow: -18px 0 36px rgba(0, 0, 0, 0.48);
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
  }

  .refinement-drawer-resize {
    position: absolute;
    z-index: 2;
    inset: 0 auto 0 -5px;
    width: 10px;
    padding: 0;
    border: 0;
    border-radius: 0;
    cursor: ew-resize;
    background: transparent;
  }

  .refinement-drawer-resize span {
    position: absolute;
    inset: 0 auto 0 4px;
    width: 2px;
    border-radius: 999px;
    background: rgba(196, 181, 253, 0.48);
  }

  .refinement-drawer-resize:hover span,
  .refinement-drawer-resize:focus-visible span {
    background: rgba(196, 181, 253, 0.95);
  }

  .refinement-drawer-resize:focus-visible {
    outline: none;
  }

  .refinement-drawer-header {
    min-width: 0;
    padding: 14px 16px 11px;
    border-bottom: 1px solid rgba(163, 113, 247, 0.28);
    background: rgba(163, 113, 247, 0.06);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .refinement-drawer-title {
    min-width: 0;
  }

  .refinement-drawer-eyebrow {
    display: block;
    margin-bottom: 4px;
    color: #c4b5fd;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .refinement-drawer-title h3 {
    margin: 0;
    font-size: 16px;
  }

  .refinement-drawer-title p {
    margin: 3px 0 0;
    color: var(--text-secondary, #8b95a5);
    font-size: 11px;
    line-height: 1.4;
  }

  .refinement-drawer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .refinement-drawer-close {
    min-width: 28px;
    padding: 2px 7px;
    font-size: 18px;
    line-height: 1;
  }

  .refinement-drawer-intro {
    padding: 9px 16px;
    color: var(--text-secondary, #8b95a5);
    background: rgba(163, 113, 247, 0.035);
    border-bottom: 1px solid var(--border, #2b3245);
    font-size: 11px;
    line-height: 1.45;
  }

  .refinement-drawer-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px 16px;
    display: grid;
    gap: 12px;
    align-content: start;
  }

  .refinement-items {
    display: grid;
    gap: 9px;
  }

  .refinement-clear {
    padding: 7px;
    border: 1px solid rgba(63, 185, 80, 0.3);
    border-radius: var(--radius-sm, 3px);
    color: #86efac;
    background: rgba(63, 185, 80, 0.06);
    font-size: 11px;
  }

  .refinement-context-block {
    display: grid;
    gap: 5px;
    font-size: 11px;
  }

  .refinement-context-block textarea {
    width: 100%;
    min-height: 72px;
  }

  .confirm-unresolved {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--yellow, #d29922);
    font-size: 11px;
  }

  .confirm-unresolved input {
    width: auto;
    margin: 0;
  }

  .refinement-confirmation-footer {
    min-width: 0;
    padding: 10px 16px;
    border-top: 1px solid rgba(163, 113, 247, 0.3);
    background: var(--bg-surface, #13171f);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .refinement-ready {
    color: var(--green, #3fb950);
    font-size: 11px;
  }

  .confirm-execution-button {
    margin-left: auto;
    white-space: nowrap;
  }

  @media (max-width: 860px) {

    .refinement-drawer {
      width: 100% !important;
      min-width: 0;
    }

    .refinement-drawer-resize {
      display: none;
    }
  }
</style>
