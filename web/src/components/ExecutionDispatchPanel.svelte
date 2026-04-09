<script>
  import { onMount, afterUpdate } from "svelte";
  import {
    getExecutionPreview,
    getRunChecklist,
    getRunScratchpad,
    launchExecutionRun,
    listExecutionRuns,
    openPullRequest,
    resolveDisambiguation,
    sendFollowUpMessage,
  } from "../lib/api.js";
  import ExecutionDispatchList from "./ExecutionDispatchList.svelte";
  import ExecutionDetailPane from "./ExecutionDetailPane.svelte";
  import ExecutionChecklist from "./ExecutionChecklist.svelte";
  import { renderMarkdown } from "../lib/markdown.js";

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
  let resolvingDisambiguation = {};
  let disambiguationContext = {};
  let scratchpadContent = {};
  let scratchpadLoading = {};
  let checklistData = {};

  // Feed scroll + auto-scroll
  let feedScrollEl;
  let prevActivityCount = 0;

  afterUpdate(() => {
    if (!feedScrollEl || !selectedRun) return;
    const count = selectedRun.activity_log?.length ?? 0;
    if (count > prevActivityCount) {
      prevActivityCount = count;
      feedScrollEl.scrollTop = feedScrollEl.scrollHeight;
    }
  });

  // Selection state
  let selectedRunId = null;
  let selectedDispatchId = null;
  // Which column is active: "run" or "dispatch"
  let activeSelection = "run";

  $: activeRuns = runs.filter((run) => ["queued", "preparing", "running", "disambiguating"].includes(run.status));
  $: disambiguatingRuns = runs.filter((run) => run.status === "disambiguating");
  $: completedRuns = runs.filter((run) => run.status === "completed");
  $: blockedRuns = runs.filter((run) => run.status === "blocked");
  $: failedRuns = runs.filter((run) => run.status === "error");

  $: dispatchNodes = preview?.groups?.flatMap((group) =>
    group.nodes.map((node) => ({
      ...node,
      group_id: group.group_id,
      repo: group.repo,
      merge_order: group.merge_order || [],
    }))
  ) || [];

  $: selectedRun = selectedRunId ? runs.find((r) => r.run_id === selectedRunId) ?? null : null;
  $: selectedDispatch = selectedDispatchId ? dispatchNodes.find((n) => n.id === selectedDispatchId) ?? null : null;
  $: selectedPullRequest = selectedRun ? selectedRun.pull_request || prResults[selectedRun.run_id] || null : null;

  // Auto-select first run or dispatch if nothing selected
  $: {
    if (!selectedRunId && runs.length) {
      const preferred = runs.find((r) => ["disambiguating", "running", "preparing", "queued"].includes(r.status)) || runs[0];
      selectedRunId = preferred.run_id;
      activeSelection = "run";
    }
    if (!selectedDispatchId && dispatchNodes.length) {
      selectedDispatchId = dispatchNodes[0].id;
    }
  }

  function selectRun(runId) {
    selectedRunId = runId;
    activeSelection = "run";
  }

  function selectDispatch(id) {
    selectedDispatchId = id;
    activeSelection = "dispatch";
  }

  function mergeRun(run) {
    if (!run) return;
    const idx = runs.findIndex((item) => item.run_id === run.run_id);
    if (idx >= 0) {
      runs = runs.map((item, i) => (i === idx ? run : item));
    } else {
      runs = [run, ...runs].slice(0, 16);
    }
  }

  async function copyValue(value, message) {
    if (!value || !window?.navigator?.clipboard) {
      copiedMessage = "Clipboard unavailable.";
      return;
    }
    try {
      await window.navigator.clipboard.writeText(value);
      copiedMessage = message;
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => { copiedMessage = ""; }, 2000);
    } catch (e) {
      copiedMessage = e.message;
    }
  }

  async function loadData({ quiet = false } = {}) {
    if (quiet) { refreshing = true; } else { loading = true; }
    error = "";
    try {
      const [nextPreview, nextRuns] = await Promise.all([getExecutionPreview(), listExecutionRuns()]);
      preview = nextPreview;
      runs = nextRuns;
      for (const run of nextRuns) {
        if (["queued", "preparing", "running", "completed", "disambiguating"].includes(run.status) && !checklistData[run.run_id]) {
          loadChecklist(run.run_id);
        }
      }
    } catch (e) {
      error = e.message;
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
    } catch (e) {
      error = e.message;
    } finally {
      openingPrRunIds = openingPrRunIds.filter((id) => id !== run.run_id);
    }
  }

  function canSendFollowUp(run) {
    return ["running", "preparing", "completed", "disambiguating"].includes(run.status);
  }

  async function handleSendFollowUp(run) {
    const text = (followUpTexts[run.run_id] || "").trim();
    if (!text) return;
    sendingFollowUp = { ...sendingFollowUp, [run.run_id]: true };
    error = "";
    followUpTexts = { ...followUpTexts, [run.run_id]: "" };
    try {
      const delivery = ["running", "preparing"].includes(run.status) ? "followUp" : undefined;
      const result = await sendFollowUpMessage({ run_id: run.run_id, message: text, ...(delivery ? { delivery } : {}) });
      if (!result.accepted) error = result.error || "Follow-up was not accepted.";
    } catch (e) {
      error = e.message;
    } finally {
      sendingFollowUp = { ...sendingFollowUp, [run.run_id]: false };
    }
  }

  // Chat history is now derived from run.activity_log (agent_message + user_message entries)

  async function loadChecklist(runId) {
    try {
      const result = await getRunChecklist(runId);
      checklistData = { ...checklistData, [runId]: result };
    } catch (e) {
      console.debug("Failed to load checklist", e);
    }
  }

  async function loadScratchpad(runId) {
    if (scratchpadContent[runId] !== undefined) return;
    scratchpadLoading = { ...scratchpadLoading, [runId]: true };
    try {
      const result = await getRunScratchpad(runId);
      scratchpadContent = { ...scratchpadContent, [runId]: result.content };
    } catch (e) {
      scratchpadContent = { ...scratchpadContent, [runId]: null };
    } finally {
      scratchpadLoading = { ...scratchpadLoading, [runId]: false };
    }
  }

  async function launchNode(node) {
    launchingIds = [...launchingIds, node.id];
    error = "";
    try {
      const result = await launchExecutionRun({ work_item_id: node.id, disambiguate: true });
      mergeRun(result.run);
      if (result.run) {
        selectedRunId = result.run.run_id;
        activeSelection = "run";
      }
      await loadData({ quiet: true });
    } catch (e) {
      error = e.message;
    } finally {
      launchingIds = launchingIds.filter((id) => id !== node.id);
    }
  }

  function launchNodeById(id) {
    const node = dispatchNodes.find((n) => n.id === id);
    if (node) launchNode(node);
  }

  async function handleResolveDisambiguation(run) {
    resolvingDisambiguation = { ...resolvingDisambiguation, [run.run_id]: true };
    error = "";
    try {
      const ctx = (disambiguationContext[run.run_id] || "").trim() || undefined;
      const result = await resolveDisambiguation({ run_id: run.run_id, additional_context: ctx });
      if (!result.resolved) error = result.error || "Failed to resolve.";
      else disambiguationContext = { ...disambiguationContext, [run.run_id]: "" };
    } catch (e) {
      error = e.message;
    } finally {
      resolvingDisambiguation = { ...resolvingDisambiguation, [run.run_id]: false };
    }
  }

  // Activity log delivered via SSE — no polling needed

  function runStatusTone(status) {
    if (status === "completed") return "healthy";
    if (["running", "preparing", "queued"].includes(status)) return "info";
    if (status === "disambiguating") return "disambiguating";
    if (status === "blocked") return "warn";
    if (status === "error") return "danger";
    return "";
  }

  function formatActivityTime(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleTimeString(); } catch { return ""; }
  }

  function activityIcon(kind) {
    if (kind === "tool_start") return "gear";
    if (kind === "tool_end") return "check";
    if (kind === "turn_start" || kind === "turn_end") return "loop";
    if (kind === "reasoning") return "idea";
    if (kind === "error") return "err";
    if (kind === "status_change") return "pin";
    return "info";
  }

  function activityKindColor(kind) {
    if (kind === "error") return "var(--red, #f85149)";
    if (kind === "tool_start" || kind === "tool_end") return "var(--accent, #2563eb)";
    if (kind === "status_change") return "var(--green, #3fb950)";
    if (kind === "reasoning") return "var(--yellow, #d29922)";
    if (kind === "turn_start" || kind === "turn_end") return "var(--purple, #a371f7)";
    if (kind === "follow_up") return "#58a6ff";
    return "var(--text-muted, #566070)";
  }

  // Group activity_log entries by turn for color-banded rendering
  const turnColors = [
    "rgba(37, 99, 235, 0.04)",
    "rgba(63, 185, 80, 0.04)",
    "rgba(163, 113, 247, 0.04)",
    "rgba(210, 153, 34, 0.04)",
  ];

  function groupByTurn(activityLog) {
    if (!activityLog?.length) return [];
    const groups = [];
    let current = { turnIndex: 0, entries: [] };
    for (const entry of activityLog) {
      if (entry.kind === "turn_start" && current.entries.length > 0) {
        groups.push(current);
        current = { turnIndex: current.turnIndex + 1, entries: [] };
      }
      current.entries.push(entry);
    }
    if (current.entries.length > 0) groups.push(current);
    return groups;
  }

  $: selectedRunTurnGroups = selectedRun ? groupByTurn(selectedRun.activity_log) : [];

  const COLLAPSE_LINE_THRESHOLD = 6;
  let expandedMessages = {};

  function toggleMessageExpand(idx) {
    expandedMessages = { ...expandedMessages, [idx]: !expandedMessages[idx] };
  }

  function shouldCollapse(text) {
    return text ? text.split("\n").length > COLLAPSE_LINE_THRESHOLD : false;
  }

  function truncateText(text) {
    return text.split("\n").slice(0, COLLAPSE_LINE_THRESHOLD).join("\n");
  }

  function handleFollowUpKeydown(event, run) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSendFollowUp(run)) handleSendFollowUp(run);
    }
  }

  onMount(() => {
    loadData();
    stream = new EventSource("/api/execution/stream");
    stream.addEventListener("open", () => { connected = true; });
    stream.addEventListener("error", () => { connected = false; });

    const handleEnvelope = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        const run = envelope.payload?.run;
        mergeRun(run);
        if (run && ["running", "disambiguating"].includes(run.status) && !checklistData[run.run_id]) {
          loadChecklist(run.run_id);
        }
      } catch (e) {
        console.error("Failed to parse execution SSE event", e);
      }
    };

    const handleChecklistEvent = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        const snapshot = envelope.payload;
        if (snapshot?.run_id) checklistData = { ...checklistData, [snapshot.run_id]: snapshot };
      } catch (e) {
        console.error("Failed to parse checklist SSE event", e);
      }
    };

    stream.addEventListener("execution_status", handleEnvelope);
    stream.addEventListener("execution_result", handleEnvelope);
    stream.addEventListener("execution_checklist", handleChecklistEvent);

    return () => {
      window.clearTimeout(copyTimer);
      stream?.close();
    };
  });
</script>

<section class="execution-panel">
  <!-- Top bar: status + summary -->
  <div class="exec-topbar">
    <div class="exec-topbar-left">
      <span class:healthy={connected} class="status-pill">{connected ? "stream connected" : "reconnecting"}</span>
      {#if preview}
        <span class="exec-stat">{preview.summary.dispatchable_now} dispatchable</span>
        <span class="exec-stat">{activeRuns.length} active</span>
        <span class="exec-stat">{completedRuns.length} done</span>
        {#if blockedRuns.length + failedRuns.length > 0}
          <span class="exec-stat warn">{blockedRuns.length + failedRuns.length} failed</span>
        {/if}
      {/if}
    </div>
    <button class="secondary small" on:click={() => loadData({ quiet: true })} disabled={refreshing || loading}>{refreshing ? "Refreshing..." : "Refresh"}</button>
  </div>

  {#if copiedMessage}
    <div class="banner success inline-banner" aria-live="polite">{copiedMessage}</div>
  {/if}
  {#if error}
    <div class="banner error inline-banner">{error}</div>
  {/if}

  {#if loading}
    <div class="empty-state">Loading execution workspace...</div>
  {:else if !preview}
    <div class="empty-state">Execution preview unavailable.</div>
  {:else}
    <div class="exec-columns">
      <!-- Left: Dispatch queue -->
      <div class="exec-col-dispatch">
        <ExecutionDispatchList
          groups={preview.groups}
          selectedDispatchId={activeSelection === "dispatch" ? selectedDispatchId : null}
          {launchingIds}
          on:select={(e) => selectDispatch(e.detail.id)}
          on:launch={(e) => launchNodeById(e.detail.id)}
        />
      </div>

      <!-- Middle: Details/context for selected item -->
      <div class="exec-col-details">
        <ExecutionDetailPane
          kind={activeSelection}
          run={activeSelection === "run" ? selectedRun : null}
          dispatchNode={activeSelection === "dispatch" ? selectedDispatch : null}
          pullRequest={selectedPullRequest}
          openingPr={selectedRun ? openingPrRunIds.includes(selectedRun.run_id) : false}
          assumptions={preview.assumptions || []}
          validationPolicy={preview.validation_policy}
          on:copybranch={() => {
            if (activeSelection === "run" && selectedRun) copyValue(selectedRun.branch, `Copied branch ${selectedRun.branch}`);
            else if (activeSelection === "dispatch" && selectedDispatch) copyValue(selectedDispatch.branch, `Copied branch ${selectedDispatch.branch}`);
          }}
          on:copyworktree={() => {
            if (activeSelection === "run" && selectedRun) copyValue(selectedRun.worktree_path, `Copied worktree`);
            else if (activeSelection === "dispatch" && selectedDispatch) copyValue(selectedDispatch.worktree_path, `Copied worktree`);
          }}
          on:openpr={() => selectedRun && handleOpenPR(selectedRun)}
          on:launch={() => selectedDispatch && launchNode(selectedDispatch)}
          scratchpadContent={selectedRun ? scratchpadContent[selectedRun.run_id] : undefined}
          scratchpadLoading={selectedRun ? !!scratchpadLoading[selectedRun.run_id] : false}
          on:scratchpadtoggle={() => selectedRun && loadScratchpad(selectedRun.run_id)}
        />
      </div>

      <!-- Right: Workspace (run pills + active run content) -->
      <div class="exec-col-workspace">
        <!-- Run pill strip -->
        {#if runs.length > 0}
          <div class="run-pill-strip">
            {#each runs as run}
              <button
                class="run-pill"
                class:active={selectedRunId === run.run_id && activeSelection === "run"}
                on:click={() => selectRun(run.run_id)}
                title="{run.work_item_id} — {run.status}"
              >
                <span class="run-pill-dot {runStatusTone(run.status)}"></span>
                <span class="run-pill-label">{run.work_item_id}</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Workspace content for selected run -->
        {#if activeSelection === "run" && selectedRun}
          {@const run = selectedRun}
          {@const checklist = checklistData[run.run_id]}
          {@const followUp = followUpTexts[run.run_id] || ""}
          {@const isSending = !!sendingFollowUp[run.run_id]}
          {@const isDisambiguating = run.status === "disambiguating"}
          {@const disambigCtx = disambiguationContext[run.run_id] || ""}
          {@const isResolving = !!resolvingDisambiguation[run.run_id]}

          <!-- Fixed header -->
          <div class="workspace-top">
            <div class="workspace-header">
              <div>
                <h3>{run.work_item_id}</h3>
                <span class="muted">{run.work_item_name}</span>
              </div>
              <span class="status-pill {runStatusTone(run.status)}">{run.status}</span>
            </div>

            {#if run.progress_message}
              <div class="workspace-progress">{run.progress_message}</div>
            {/if}

            <!-- Checklist (collapsible, open by default) -->
            {#if checklist?.items?.length}
              <details class="workspace-expandable" open>
                <summary>Checklist ({checklist.items.filter(i => i.checked).length}/{checklist.items.length})</summary>
                <ExecutionChecklist items={checklist.items} />
              </details>
            {/if}

            <!-- Disambiguation banner -->
            {#if isDisambiguating}
              <div class="disambig-banner">
                <strong>Setup phase</strong>
                <span class="muted">Review the plan, answer questions, then approve to start coding.</span>
              </div>
            {/if}
          </div>

          <!-- Scrollable feed -->
          <div class="workspace-feed-scroll" bind:this={feedScrollEl}>
            {#if selectedRunTurnGroups.length > 0}
              <div class="unified-feed">
                {#each selectedRunTurnGroups as group, gi}
                  <div class="turn-band" style="background: {turnColors[group.turnIndex % turnColors.length]}">
                    {#each group.entries as entry, ei}
                      {@const globalIdx = `${gi}-${ei}`}
                      {#if entry.kind === "agent_message"}
                        <div class="feed-chat feed-chat-assistant">
                          <div class="feed-chat-hdr">
                            <span class="feed-chat-role">Agent</span>
                            <span class="feed-chat-ts">{formatActivityTime(entry.timestamp)}</span>
                            {#if shouldCollapse(entry.message)}
                              <button class="feed-expand-btn" on:click={() => toggleMessageExpand(globalIdx)}>
                                {expandedMessages[globalIdx] ? "collapse" : "expand"}
                              </button>
                            {/if}
                          </div>
                          <div class="feed-chat-body" class:feed-chat-collapsed={shouldCollapse(entry.message) && !expandedMessages[globalIdx]}>
                            {expandedMessages[globalIdx] || !shouldCollapse(entry.message) ? entry.message : truncateText(entry.message)}
                          </div>
                          {#if shouldCollapse(entry.message) && !expandedMessages[globalIdx]}
                            <button class="feed-expand-inline" on:click={() => toggleMessageExpand(globalIdx)}>Show full message ({entry.message.split("\n").length} lines)</button>
                          {/if}
                        </div>
                      {:else if entry.kind === "user_message"}
                        <div class="feed-chat feed-chat-user">
                          <div class="feed-chat-hdr">
                            <span class="feed-chat-role">You</span>
                            <span class="feed-chat-ts">{formatActivityTime(entry.timestamp)}</span>
                          </div>
                          <div class="feed-chat-body">{entry.message}</div>
                        </div>
                      {:else if entry.kind === "turn_start" || entry.kind === "turn_end"}
                        <!-- Absorbed into band color -->
                      {:else}
                        <div class="feed-activity" style="--activity-color: {activityKindColor(entry.kind)}">
                          <span class="feed-activity-kind">{activityIcon(entry.kind)}</span>
                          <span class="feed-activity-ts">{formatActivityTime(entry.timestamp)}</span>
                          <span class="feed-activity-msg">{entry.message}</span>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/each}

                <!-- Pinned summary cards at end of feed -->
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

          <!-- Pinned input at bottom -->
          {#if canSendFollowUp(run)}
            <div class="workspace-input-pinned">
              <div class="chat-input-row">
                <textarea
                  placeholder={isDisambiguating ? "Answer questions or add context..." : ["running", "preparing"].includes(run.status) ? "Steer or follow up..." : "Send a follow-up..."}
                  value={followUp}
                  on:input={(e) => followUpTexts = { ...followUpTexts, [run.run_id]: e.currentTarget.value }}
                  on:keydown={(e) => handleFollowUpKeydown(e, run)}
                  rows="2"
                  disabled={isSending}
                ></textarea>
                <button on:click={() => handleSendFollowUp(run)} disabled={isSending || !followUp.trim()}>
                  {isSending ? "..." : "Send"}
                </button>
              </div>

              {#if isDisambiguating}
                <div class="chat-input-row">
                  <textarea
                    placeholder="Optional: final context for the coding agent..."
                    value={disambigCtx}
                    on:input={(e) => disambiguationContext = { ...disambiguationContext, [run.run_id]: e.currentTarget.value }}
                    rows="2"
                    disabled={isResolving}
                  ></textarea>
                  <button on:click={() => handleResolveDisambiguation(run)} disabled={isResolving}>
                    {isResolving ? "Starting..." : "Proceed to coding"}
                  </button>
                </div>
              {/if}
            </div>
          {/if}

        {:else if activeSelection === "dispatch" && selectedDispatch}
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
    </div>
  {/if}
</section>

<style>
  /* Top bar */
  .exec-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-shrink: 0;
    padding: 0 2px;
  }

  .exec-topbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .exec-stat {
    font-size: 11px;
    color: var(--text-muted, #566070);
  }

  .exec-stat.warn {
    color: var(--red, #f85149);
  }

  /* Three-column layout */
  .exec-columns {
    display: grid;
    grid-template-columns: 220px 300px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .exec-col-dispatch {
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    border-right: 1px solid var(--border, #2b3245);
    padding: 6px;
  }

  .exec-col-details {
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    border-right: 1px solid var(--border, #2b3245);
  }

  .exec-col-workspace {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Run pill strip */
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

  .run-pill-dot.healthy { background: var(--green, #3fb950); }
  .run-pill-dot.info { background: var(--accent, #2563eb); }
  .run-pill-dot.disambiguating { background: var(--purple, #a371f7); }
  .run-pill-dot.warn { background: var(--yellow, #d29922); }
  .run-pill-dot.danger { background: var(--red, #f85149); }

  .run-pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Workspace top (header + expandable sections, scrollable if tall) */
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

  /* Workspace feed (scrollable middle) */
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

  /* Workspace input (pinned bottom) */
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

  .workspace-section {
    display: grid;
    gap: 6px;
  }

  .workspace-section-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
  }

  .workspace-section-hdr h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary, #8b95a5);
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

  /* Unified feed */
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

  /* Chat entries — prominent */
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

  /* Activity entries — dimmed, compact, color-coded */
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

  /* Chat input area */
  .feed-input-area {
    display: grid;
    gap: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--border, #2b3245);
  }

  .chat-input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px;
    align-items: end;
  }

  .disambig-banner {
    display: grid;
    gap: 2px;
    padding: 5px 8px;
    border-radius: var(--radius-sm, 3px);
    background: rgba(163, 113, 247, 0.08);
    border: 1px solid rgba(163, 113, 247, 0.2);
    font-size: 12px;
  }

  /* Expandables */
  .workspace-expandable {
    padding: 6px 8px;
    border: 1px solid var(--border, #2b3245);
    border-radius: var(--radius-sm, 3px);
    background: var(--bg-surface, #13171f);
    font-size: 12px;
  }

  .workspace-expandable summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 11px;
    color: var(--text-secondary, #8b95a5);
  }

  .workspace-expandable pre {
    margin: 4px 0 0;
    white-space: pre-wrap;
    line-height: 1.45;
    font-size: 11px;
  }

  .workspace-expandable ul {
    margin: 4px 0 0;
    padding-left: 14px;
    font-size: 11px;
  }

  /* Collapsed agent messages */
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

  /* Pinned summary cards */
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

  /* Responsive */
  @media (max-width: 1100px) {
    .exec-columns {
      grid-template-columns: 200px minmax(0, 1fr);
    }

    .exec-col-details {
      display: none;
    }
  }

  @media (max-width: 860px) {
    .exec-columns {
      grid-template-columns: 1fr;
      overflow-y: auto;
    }

    .exec-col-dispatch {
      border-right: none;
      border-bottom: 1px solid var(--border, #2b3245);
    }
  }
</style>
