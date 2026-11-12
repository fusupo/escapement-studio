<script>

/** @type {{ workspace: ReturnType<typeof import("../lib/execution/workspace.svelte.js").createWorkspace> }} */
let { workspace } = $props();
const run = $derived(workspace.selectedRun);
</script>
<div class="workspace-feed-scroll" {@attach workspace.attachFeedScroll}>
            {#if workspace.selectedRunTurnGroups.length > 0}
              <div class="unified-feed">
                {#each workspace.selectedRunTurnGroups as group, gi}
                  <div class="turn-band" style="background: {workspace.turnColors[group.turnIndex % workspace.turnColors.length]}">
                    {#each group.entries as entry, ei}
                      {@const globalIdx = `${gi}-${ei}`}
                      {#if entry.kind === "agent_message"}
                        <div class="feed-chat feed-chat-assistant">
                          <div class="feed-chat-hdr">
                            <span class="feed-chat-role">Agent</span>
                            <span class="feed-chat-ts">{workspace.formatActivityTime(entry.timestamp)}</span>
                            {#if workspace.shouldCollapse(entry.message)}
                              <button class="feed-expand-btn" onclick={() => workspace.toggleMessageExpand(globalIdx)}>
                                {workspace.expandedMessages[globalIdx] ? "collapse" : "expand"}
                              </button>
                            {/if}
                          </div>
                          <div class="feed-chat-body" class:feed-chat-collapsed={workspace.shouldCollapse(entry.message) && !workspace.expandedMessages[globalIdx]}>
                            {workspace.expandedMessages[globalIdx] || !workspace.shouldCollapse(entry.message) ? entry.message : workspace.truncateText(entry.message)}
                          </div>
                          {#if workspace.shouldCollapse(entry.message) && !workspace.expandedMessages[globalIdx]}
                            <button class="feed-expand-inline" onclick={() => workspace.toggleMessageExpand(globalIdx)}>Show full message ({entry.message.split("\n").length} lines)</button>
                          {/if}
                        </div>
                      {:else if entry.kind === "user_message"}
                        <div class="feed-chat feed-chat-user">
                          <div class="feed-chat-hdr">
                            <span class="feed-chat-role">You</span>
                            <span class="feed-chat-ts">{workspace.formatActivityTime(entry.timestamp)}</span>
                          </div>
                          <div class="feed-chat-body">{entry.message}</div>
                        </div>
                      {:else if entry.kind === "turn_start" || entry.kind === "turn_end"}
                        <!-- Absorbed into band color -->
                      {:else}
                        <div class="feed-activity" style="--activity-color: {workspace.activityKindColor(entry.kind)}">
                          <span class="feed-activity-kind">{workspace.activityIcon(entry.kind)}</span>
                          <span class="feed-activity-ts">{workspace.formatActivityTime(entry.timestamp)}</span>
                          <span class="feed-activity-msg">{entry.message}</span>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/each}

                <!-- Pinned summary cards at end of feed -->
                {#if run.terminal_outcome}
                  <div class="feed-pinned-card" class:feed-pinned-error={run.terminal_outcome.severity === "warn"}>
                    <div class="feed-pinned-hdr">Outcome</div>
                    <ul class="feed-pinned-list">
                      <li><strong>{run.terminal_outcome.label}</strong> — {run.terminal_outcome.detail}</li>
                      <li>Changed files: {run.terminal_outcome.changed_file_count}</li>
                      <li>Summary present: {run.terminal_outcome.summary_present ? "yes" : "no"}</li>
                    </ul>
                  </div>
                {/if}
                {#if run.result_summary}
                  <div class="feed-pinned-card">
                    <div class="feed-pinned-hdr">Result summary</div>
                    <pre class="feed-pinned-pre">{run.result_summary}</pre>
                  </div>
                {/if}
                {#if run.changed_files?.length}
                  <div class="feed-pinned-card">
                    <div class="feed-pinned-hdr">Changed files ({run.changed_files.length})</div>
                    <ul class="feed-pinned-list">{#each run.changed_files as path}<li>{path}</li>{/each}</ul>
                  </div>
                {/if}
                {#if run.errors?.length}
                  <div class="feed-pinned-card feed-pinned-error">
                    <div class="feed-pinned-hdr">Errors ({run.errors.length})</div>
                    <ul class="feed-pinned-list">{#each run.errors as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
                  </div>
                {/if}
              </div>
            {:else if ["running", "preparing", "disambiguating"].includes(run.status)}
              <div class="workspace-empty muted">Waiting for agent activity...</div>
            {/if}
          </div>

<style>
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

  .workspace-empty {
    padding: 8px;
    font-size: 11px;
  }
  .unified-feed {
    display: grid;
    gap: 0;
  }

  .turn-band {
    display: grid;
    gap: 2px;
    padding: 4px 6px;
    border-radius: var(--radius-sm, 3px);
    margin-bottom: 2px;
  }
  .feed-chat {
    display: grid;
    gap: 2px;
    padding: 6px 8px;
    border-radius: var(--radius-sm, 3px);
    border: 1px solid var(--border, #2b3245);
    background: var(--bg-surface, #13171f);
    font-size: 12px;
  }

  .feed-chat-assistant { border-color: rgba(63, 185, 80, 0.2); }
  .feed-chat-user { border-color: rgba(37, 99, 235, 0.25); background: rgba(37, 99, 235, 0.06); }

  .feed-chat-hdr { display: flex; justify-content: space-between; gap: 4px; }
  .feed-chat-role { font-size: 10.5px; font-weight: 600; color: var(--text-secondary, #8b95a5); }
  .feed-chat-ts { font-size: 10.5px; color: var(--text-muted, #566070); }

  .feed-chat-body {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  .feed-activity {
    display: grid;
    grid-template-columns: 3.2em 4.5em 1fr;
    gap: 4px;
    align-items: baseline;
    padding: 2px 8px;
    font-size: 11px;
    opacity: 0.6;
    transition: opacity 100ms;
  }

  .feed-activity:hover {
    opacity: 1;
  }

  .feed-activity-kind {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--activity-color);
  }

  .feed-activity-ts {
    font-size: 10px;
    color: var(--text-muted, #566070);
  }

  .feed-activity-msg {
    color: var(--text-secondary, #8b95a5);
  }
  .feed-chat-collapsed {
    mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
  }

  .feed-expand-btn {
    padding: 0 4px;
    background: transparent;
    color: var(--text-muted, #566070);
    font-size: 10px;
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }

  .feed-expand-btn:hover { color: var(--text-secondary, #8b95a5); }

  .feed-expand-inline {
    padding: 2px 0;
    background: transparent;
    color: var(--accent, #2563eb);
    font-size: 10.5px;
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .feed-expand-inline:hover { text-decoration: underline; }
  .feed-pinned-card {
    padding: 6px 8px;
    border-radius: var(--radius-sm, 3px);
    border: 1px solid var(--border, #2b3245);
    background: var(--bg-surface, #13171f);
    font-size: 12px;
    margin-top: 4px;
  }

  .feed-pinned-error { border-color: rgba(248, 81, 73, 0.3); }

  .feed-pinned-hdr {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary, #8b95a5);
    margin-bottom: 4px;
  }

  .feed-pinned-pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    line-height: 1.45;
  }

  .feed-pinned-list {
    margin: 0;
    padding-left: 14px;
    font-size: 11px;
  }
</style>
