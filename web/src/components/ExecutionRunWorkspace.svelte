<script>

import ExecutionChecklist from "./ExecutionChecklist.svelte";
import ExecutionArchivedList from "./ExecutionArchivedList.svelte";

import { unresolvedRefinementItems } from "../lib/execution-refinement.js";

/** @type {ReturnType<typeof import("../lib/execution/workspace.svelte.js").createWorkspace>} */
export let workspace;

import ExecutionActivityFeed from './ExecutionActivityFeed.svelte';
</script>
<div class="exec-col-workspace">
        <details class="workspace-expandable archived-section">
          <summary>Archived runs</summary>
          <ExecutionArchivedList bundles={workspace.archivedBundles} loading={workspace.archivedLoading} error={workspace.archivedError} onCopy={workspace.copyValue} />
        </details>

        <!-- Run pill strip -->
        {#if workspace.runs.length > 0}
          <div class="run-pill-strip">
            {#each workspace.runs as run}
              {@const reconciled = workspace.reconciledByWorkItem[run.work_item_id]}
              {@const nextAction = reconciled?.next_action}
              {@const showReconciledBadge = nextAction && ["open_pr", "relaunch", "investigate", "close_out"].includes(nextAction)}
              <button
                class="run-pill"
                class:active={workspace.selectedRunId === run.run_id && workspace.activeSelection === "run"}
                on:click={() => workspace.selectRun(run.run_id)}
                title={reconciled?.rationale || `${run.work_item_id} — ${run.status}`}
              >
                <span class="run-pill-dot {workspace.runStatusTone(run)}"></span>
                <span class="run-pill-label">{run.work_item_id}</span>
                {#if showReconciledBadge}
                  <span class="run-pill-next-action" data-next-action={nextAction}>{nextAction.replace("_", " ")}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}

        <!-- Workspace content for selected run -->
        {#if workspace.activeSelection === "run" && workspace.selectedRun}
          {@const run = workspace.selectedRun}
          {@const checklist = workspace.checklistData[run.run_id]}
          {@const followUp = workspace.followUpTexts[run.run_id] || ""}
          {@const isSending = !!workspace.sendingFollowUp[run.run_id]}
          {@const isDisambiguating = run.status === "disambiguating"}
          {@const unresolvedItems = unresolvedRefinementItems(run, workspace.refinementResponses)}

          <!-- Fixed header -->
          <div class="workspace-top">
            <div class="workspace-header">
              <div>
                <h3>{run.work_item_id}</h3>
                <span class="muted">{run.work_item_name}</span>
              </div>
              <span class="status-pill {workspace.runStatusTone(run)}">{run.terminal_outcome?.label || run.phase || run.status}</span>
            </div>

            {#if run.progress_message}
              <div class="workspace-progress">{run.progress_message}</div>
            {/if}

            <!-- Checklist (collapsible, open by default) -->
            {#if checklist}
              <details class="workspace-expandable" open>
                <summary>Implementation ({checklist.completed}/{checklist.total})</summary>
                <ExecutionChecklist snapshot={checklist} />
              </details>
            {/if}

            <!-- Disambiguation banner -->
            {#if isDisambiguating}
              <div class="disambig-banner">
                <div class="disambig-banner-copy">
                  <strong>Execution refinement complete</strong>
                  <span class="muted">The approved plan was checked in the isolated worktree. Review the open items, then explicitly start coding. This checkpoint survives a Studio restart.</span>
                </div>
                <button
                  class="secondary small"
                  on:click={() => workspace.setRefinementDrawerClosed(run.run_id, false)}
                >Review &amp; confirm ({unresolvedItems.length})</button>
              </div>
            {/if}
          </div>

          <!-- Scrollable feed -->
          <ExecutionActivityFeed {workspace} />
          {#if workspace.canSendFollowUp(run)}
            <div class="workspace-input-pinned">
              <div class="chat-input-row">
                <textarea
                  placeholder={["running", "preparing"].includes(run.status) ? "Steer or follow up..." : "Send a follow-up..."}
                  value={followUp}
                  on:input={(e) => workspace.followUpTexts = { ...workspace.followUpTexts, [run.run_id]: e.currentTarget.value }}
                  on:keydown={(e) => workspace.handleFollowUpKeydown(e, run)}
                  rows="2"
                  disabled={isSending}
                ></textarea>
                <button on:click={() => workspace.handleSendFollowUp(run)} disabled={isSending || !followUp.trim()}>
                  {isSending ? "..." : "Send"}
                </button>
              </div>
            </div>
          {/if}

        {:else if workspace.activeSelection === "dispatch" && workspace.selectedDispatch}
          <div class="workspace-feed-scroll">
            <div class="workspace-empty large muted">
              Dispatch candidate selected. See details in the middle column, or launch to create a run.
            </div>
          </div>
        {:else}
          <div class="workspace-feed-scroll">
            <div class="workspace-empty large muted">No runs yet. Launch a dispatch candidate to get started.</div>
          </div>
        {/if}
      </div>
<style>
  .exec-col-workspace {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .run-pill-strip {
    display: flex;
    gap: 2px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border, #2b3245);
    background: var(--bg-surface, #13171f);
    overflow-x: auto;
    overflow-y: hidden;
    flex-shrink: 0;
  }

  .run-pill-strip::-webkit-scrollbar {
    height: 3px;
  }

  .run-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 3px);
    color: var(--text-secondary, #8b95a5);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .run-pill:hover {
    background: rgba(255, 255, 255, 0.03);
    border-color: var(--border, #2b3245);
  }

  .run-pill.active {
    background: var(--accent-muted, rgba(37, 99, 235, 0.25));
    border-color: rgba(37, 99, 235, 0.5);
    color: var(--text-primary, #e2e8f0);
  }

  .run-pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted, #566070);
    flex-shrink: 0;
  }
  .run-pill-dot.disambiguating { background: var(--purple, #a371f7); }

  .run-pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .run-pill-next-action {
    display: inline-flex;
    padding: 0 5px;
    border-radius: 2px;
    background: rgba(37, 99, 235, 0.2);
    color: #bfdbfe;
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .run-pill-next-action[data-next-action="open_pr"] {
    background: rgba(63, 185, 80, 0.2);
    color: #86efac;
  }
  .run-pill-next-action[data-next-action="investigate"] {
    background: rgba(248, 81, 73, 0.2);
    color: #fca5a5;
  }
  .run-pill-next-action[data-next-action="relaunch"] {
    background: rgba(210, 153, 34, 0.2);
    color: #facc15;
  }
  .run-pill-next-action[data-next-action="close_out"] {
    background: rgba(63, 185, 80, 0.25);
    color: #86efac;
  }
  .workspace-top {
    flex-shrink: 0;
    max-height: 45%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 8px 4px;
    display: grid;
    gap: 6px;
    border-bottom: 1px solid var(--border, #2b3245);
  }
  .workspace-feed-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 6px 8px;
    display: grid;
    gap: 4px;
    align-content: start;
  }
  .workspace-input-pinned {
    flex-shrink: 0;
    padding: 6px 8px;
    border-top: 1px solid var(--border, #2b3245);
    display: grid;
    gap: 4px;
  }

  .workspace-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 6px;
  }

  .workspace-header h3 { margin: 0; font-size: 14px; }

  .workspace-progress {
    padding: 5px 8px;
    border-radius: var(--radius-sm, 3px);
    background: rgba(37, 99, 235, 0.1);
    border: 1px solid rgba(37, 99, 235, 0.25);
    color: #bfdbfe;
    font-size: 12px;
  }

  .workspace-empty {
    padding: 8px;
    font-size: 11px;
  }

  .workspace-empty.large {
    min-height: 8rem;
    display: grid;
    place-items: center;
  }

  .chat-input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px;
    align-items: end;
  }

  .disambig-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 8px;
    border-radius: var(--radius-sm, 3px);
    background: rgba(163, 113, 247, 0.08);
    border: 1px solid rgba(163, 113, 247, 0.2);
    font-size: 12px;
  }

  .disambig-banner-copy {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .disambig-banner button {
    flex-shrink: 0;
  }
  .workspace-expandable {
    padding: 6px 8px;
    border: 1px solid var(--border, #2b3245);
    border-radius: var(--radius-sm, 3px);
    background: var(--bg-surface, #13171f);
    font-size: 12px;
  }

  .archived-section {
    margin: 8px 8px 0;
    flex-shrink: 0;
  }

  .workspace-expandable summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 11px;
    color: var(--text-secondary, #8b95a5);
  }

  @media (max-width: 860px) {

    .disambig-banner {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
