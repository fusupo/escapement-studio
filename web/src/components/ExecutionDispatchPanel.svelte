<script>
  import { onMount } from "svelte";
  import { getExecutionPreview, getRunChatHistory, launchExecutionRun, listExecutionRuns, openPullRequest, sendFollowUpMessage } from "../lib/api.js";

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
  let openingPrRunIds = [];
  let prResults = {};
  let followUpTexts = {};
  let sendingFollowUp = {};
  let chatHistories = {};
  let expandedChat = {};

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

  function activityIcon(kind) {
    if (kind === "tool_start") return "⚙️";
    if (kind === "tool_end") return "✅";
    if (kind === "turn_start" || kind === "turn_end") return "🔄";
    if (kind === "reasoning") return "💡";
    if (kind === "error") return "❌";
    if (kind === "status_change") return "📌";
    return "ℹ️";
  }

  function formatActivityTime(timestamp) {
    if (!timestamp) return "";
    try {
      return new Date(timestamp).toLocaleTimeString();
    } catch {
      return "";
    }
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

  async function handleOpenPR(run) {
    openingPrRunIds = [...openingPrRunIds, run.run_id];
    error = "";
    try {
      const result = await openPullRequest({ run_id: run.run_id, auto_commit: true });
      mergeRun(result.run);
      prResults = { ...prResults, [run.run_id]: result.pull_request };
    } catch (prError) {
      error = prError.message;
    } finally {
      openingPrRunIds = openingPrRunIds.filter((id) => id !== run.run_id);
    }
  }

  function canSendFollowUp(run) {
    return ["running", "preparing", "completed"].includes(run.status);
  }

  async function handleSendFollowUp(run) {
    const text = (followUpTexts[run.run_id] || "").trim();
    if (!text) return;

    sendingFollowUp = { ...sendingFollowUp, [run.run_id]: true };
    error = "";

    // Optimistically add to local chat history
    const userMsg = { timestamp: new Date().toISOString(), role: "user", text };
    chatHistories = {
      ...chatHistories,
      [run.run_id]: [...(chatHistories[run.run_id] || []), userMsg],
    };
    followUpTexts = { ...followUpTexts, [run.run_id]: "" };
    expandedChat = { ...expandedChat, [run.run_id]: true };

    try {
      const delivery = ["running", "preparing"].includes(run.status) ? "followUp" : undefined;
      const result = await sendFollowUpMessage({
        run_id: run.run_id,
        message: text,
        ...(delivery ? { delivery } : {}),
      });
      if (!result.accepted) {
        error = result.error || "Follow-up was not accepted.";
      }
    } catch (followUpError) {
      error = followUpError.message;
    } finally {
      sendingFollowUp = { ...sendingFollowUp, [run.run_id]: false };
    }
  }

  async function loadChatHistory(runId) {
    try {
      const result = await getRunChatHistory(runId);
      chatHistories = { ...chatHistories, [runId]: result.messages || [] };
    } catch (chatError) {
      console.error("Failed to load chat history", chatError);
    }
  }

  function toggleChat(runId) {
    const next = !expandedChat[runId];
    expandedChat = { ...expandedChat, [runId]: next };
    if (next && !chatHistories[runId]) {
      loadChatHistory(runId);
    }
  }

  function handleFollowUpKeydown(event, run) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSendFollowUp(run);
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

<section class="execution-panel">
  <div class="panel-header execution-header">
    <div>
      <h2>Dispatch execution work</h2>
      <p class="muted">Launch dispatchable work, track live runs, inspect worktree and branch context, and prep PR or sync follow-up without leaving the Execute tab.</p>
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
                    <p class="run-progress-message">{run.progress_message}</p>
                  {/if}

                  {#if run.activity_log?.length}
                    <details class="activity-log-details" open={["running", "preparing"].includes(run.status)}>
                      <summary>Activity log ({run.activity_log.length} event{run.activity_log.length === 1 ? '' : 's'})</summary>
                      <div class="activity-log">
                        {#each run.activity_log as entry}
                          <div class="activity-entry activity-{entry.kind}">
                            <span class="activity-icon">{activityIcon(entry.kind)}</span>
                            <span class="activity-time">{formatActivityTime(entry.timestamp)}</span>
                            <span class="activity-message">{entry.message}</span>
                          </div>
                        {/each}
                      </div>
                    </details>
                  {:else if ["running", "preparing"].includes(run.status)}
                    <div class="activity-log-placeholder muted small-text">Waiting for activity events…</div>
                  {/if}

                  <div class="execute-card-actions">
                    {#if run.issue_url}
                      <a class="ghost-link small" href={run.issue_url} target="_blank" rel="noreferrer">Open issue</a>
                    {/if}
                    <button class="secondary small" on:click={() => copyValue(run.branch, `Copied branch ${run.branch}`)}>Copy branch</button>
                    <button class="secondary small" on:click={() => copyValue(run.worktree_path, `Copied worktree for ${run.work_item_id}`)}>Copy worktree</button>
                    {#if canSendFollowUp(run)}
                      <button class="secondary small" on:click={() => toggleChat(run.run_id)}>
                        {expandedChat[run.run_id] ? 'Hide chat' : 'Follow-up chat'}
                      </button>
                    {/if}
                    {#if run.status === "completed"}
                      {#if run.pull_request}
                        <a class="ghost-link small" href={run.pull_request.url} target="_blank" rel="noreferrer">PR #{run.pull_request.number}</a>
                      {:else if prResults[run.run_id]}
                        <a class="ghost-link small" href={prResults[run.run_id].url} target="_blank" rel="noreferrer">PR #{prResults[run.run_id].number}</a>
                      {:else}
                        <button on:click={() => handleOpenPR(run)} disabled={openingPrRunIds.includes(run.run_id)}>
                          {openingPrRunIds.includes(run.run_id) ? 'Opening PR…' : 'Open PR'}
                        </button>
                      {/if}
                      <a class="ghost-link small" href="#reconciliation-panel">Review reconciliation</a>
                    {/if}
                  </div>

                  {#if expandedChat[run.run_id] && canSendFollowUp(run)}
                    <div class="follow-up-chat">
                      {#if chatHistories[run.run_id]?.length}
                        <div class="follow-up-messages">
                          {#each chatHistories[run.run_id] as msg}
                            <div class="follow-up-msg follow-up-{msg.role}">
                              <span class="follow-up-role">{msg.role === 'user' ? 'You' : 'Agent'}</span>
                              <span class="follow-up-time">{formatActivityTime(msg.timestamp)}</span>
                              <div class="follow-up-text">{msg.text}</div>
                            </div>
                          {/each}
                        </div>
                      {/if}
                      <div class="follow-up-input-row">
                        <textarea
                          class="follow-up-input"
                          placeholder={["running", "preparing"].includes(run.status) ? "Steer or follow up on the active run…" : "Send a follow-up message to continue this run…"}
                          bind:value={followUpTexts[run.run_id]}
                          on:keydown={(e) => handleFollowUpKeydown(e, run)}
                          rows="2"
                          disabled={sendingFollowUp[run.run_id]}
                        ></textarea>
                        <button
                          class="follow-up-send"
                          on:click={() => handleSendFollowUp(run)}
                          disabled={sendingFollowUp[run.run_id] || !(followUpTexts[run.run_id] || '').trim()}
                        >
                          {sendingFollowUp[run.run_id] ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    </div>
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

  .run-progress-message {
    margin: 0;
  }

  .activity-log-details {
    border: 1px solid rgba(148, 163, 184, 0.12);
    border-radius: 8px;
    overflow: hidden;
  }

  .activity-log-details summary {
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
    background: rgba(15, 23, 42, 0.5);
    color: #93c5fd;
    user-select: none;
  }

  .activity-log {
    max-height: 240px;
    overflow-y: auto;
    display: grid;
    gap: 0;
    font-size: 0.8rem;
  }

  .activity-entry {
    display: grid;
    grid-template-columns: 1.4em 5.2em 1fr;
    gap: 0.35rem;
    align-items: baseline;
    padding: 0.25rem 0.75rem;
    border-top: 1px solid rgba(148, 163, 184, 0.06);
  }

  .activity-entry:first-child {
    border-top: none;
  }

  .activity-icon {
    font-size: 0.75rem;
    text-align: center;
  }

  .activity-time {
    color: #64748b;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .activity-message {
    color: #e2e8f0;
    word-break: break-word;
  }

  .activity-reasoning .activity-message {
    color: #fde68a;
    font-style: italic;
  }

  .activity-error .activity-message {
    color: #fca5a5;
  }

  .activity-tool_start .activity-message,
  .activity-tool_end .activity-message {
    color: #93c5fd;
  }

  .activity-log-placeholder {
    padding: 0.5rem 0;
  }

  /* Follow-up chat */
  .follow-up-chat {
    border: 1px solid rgba(148, 163, 184, 0.14);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(15, 23, 42, 0.45);
  }

  .follow-up-messages {
    max-height: 200px;
    overflow-y: auto;
    padding: 0.5rem 0.65rem;
    display: grid;
    gap: 0.5rem;
  }

  .follow-up-msg {
    display: grid;
    gap: 0.15rem;
  }

  .follow-up-role {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .follow-up-user .follow-up-role {
    color: #93c5fd;
  }

  .follow-up-assistant .follow-up-role {
    color: #86efac;
  }

  .follow-up-time {
    font-size: 0.7rem;
    color: #64748b;
  }

  .follow-up-text {
    font-size: 0.82rem;
    color: #e2e8f0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
  }

  .follow-up-input-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0.65rem;
    border-top: 1px solid rgba(148, 163, 184, 0.1);
    align-items: flex-end;
  }

  .follow-up-input {
    flex: 1;
    resize: vertical;
    min-height: 2.2rem;
    max-height: 6rem;
    padding: 0.45rem 0.6rem;
    border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(2, 6, 23, 0.6);
    color: #e2e8f0;
    font-size: 0.85rem;
    font-family: inherit;
    line-height: 1.4;
  }

  .follow-up-input::placeholder {
    color: #64748b;
  }

  .follow-up-input:focus {
    outline: none;
    border-color: rgba(96, 165, 250, 0.5);
  }

  .follow-up-send {
    align-self: flex-end;
    white-space: nowrap;
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
