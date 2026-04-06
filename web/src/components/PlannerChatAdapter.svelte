<script>
  import { createEventDispatcher, onMount } from "svelte";
  import {
    approveGitHubSync,
    approveMemoryChange,
    approveMutationProposal,
    getPlannerSessionSnapshot,
    sendAgentMessage,
  } from "../lib/api.js";
  import { connectPlannerStream, extractMessageText, toToolStatus } from "../lib/planner-chat.js";

  const dispatch = createEventDispatcher();
  const graphModes = ["default", "focused", "full"];

  let draft = "";
  let graphMode = "default";
  let repo = "";
  let track = "";
  let messages = [];
  let toolEvents = [];
  let loading = true;
  let sending = false;
  let approving = false;
  let connected = false;
  let error = "";
  let sessionId = "";
  let isStreaming = false;
  let activeProposal = null;
  let selectedMutationIds = [];
  let lastCommitResult = null;
  let activeMemoryChange = null;
  let selectedMemoryEditIds = [];
  let lastMemoryWriteResult = null;
  let activeGitHubSync = null;
  let selectedGitHubOperationIds = [];
  let lastGitHubSyncResult = null;
  let memoryDocument = null;
  let recentSubagentRuns = [];
  let hasLoadedSnapshot = false;
  let stream;

  function syncMutationSelection(proposal, preserve = false) {
    if (!proposal) {
      selectedMutationIds = [];
      return;
    }

    const ids = proposal.mutations?.map((mutation) => mutation.id) ?? [];
    selectedMutationIds = preserve ? selectedMutationIds.filter((id) => ids.includes(id)) : ids;
  }

  function syncMemorySelection(change, preserve = false) {
    if (!change) {
      selectedMemoryEditIds = [];
      return;
    }

    const ids = change.edits?.map((edit) => edit.id) ?? [];
    selectedMemoryEditIds = preserve ? selectedMemoryEditIds.filter((id) => ids.includes(id)) : ids;
  }

  function syncGitHubSelection(sync, preserve = false) {
    if (!sync) {
      selectedGitHubOperationIds = [];
      return;
    }

    const ids = sync.operations?.map((operation) => operation.id) ?? [];
    selectedGitHubOperationIds = preserve ? selectedGitHubOperationIds.filter((id) => ids.includes(id)) : ids;
  }

  function mergeSnapshot(snapshot) {
    sessionId = snapshot.session_id;
    isStreaming = snapshot.is_streaming;
    messages = snapshot.messages ?? [];
    lastCommitResult = snapshot.last_commit_result ?? null;
    lastMemoryWriteResult = snapshot.last_memory_write_result ?? null;
    lastGitHubSyncResult = snapshot.last_github_sync_result ?? null;
    memoryDocument = snapshot.memory ?? null;
    recentSubagentRuns = snapshot.recent_subagent_runs ?? [];

    const nextProposal = snapshot.active_proposal ?? null;
    const proposalChanged = nextProposal?.proposal_id !== activeProposal?.proposal_id;
    activeProposal = nextProposal;
    syncMutationSelection(activeProposal, !proposalChanged);

    const nextMemoryChange = snapshot.active_memory_change ?? null;
    const memoryChanged = nextMemoryChange?.change_id !== activeMemoryChange?.change_id;
    activeMemoryChange = nextMemoryChange;
    syncMemorySelection(activeMemoryChange, !memoryChanged);

    const nextGitHubSync = snapshot.active_github_sync ?? null;
    const githubChanged = nextGitHubSync?.sync_id !== activeGitHubSync?.sync_id;
    activeGitHubSync = nextGitHubSync;
    syncGitHubSelection(activeGitHubSync, !githubChanged);
  }

  async function loadSnapshot() {
    loading = true;
    error = "";

    try {
      mergeSnapshot(await getPlannerSessionSnapshot());
    } catch (loadError) {
      error = loadError.message;
    } finally {
      hasLoadedSnapshot = true;
      loading = false;
    }
  }

  function appendMessage(nextMessage) {
    const existingIndex = messages.findIndex((message) => message.id === nextMessage.id);
    if (existingIndex >= 0) {
      messages = messages.map((message, index) => (index === existingIndex ? { ...message, ...nextMessage } : message));
      return;
    }

    messages = [...messages, nextMessage];
  }

  function handlePlannerEvent(event) {
    sessionId = event.session_id || sessionId;

    if (event.event_type === "mutation_proposal") {
      activeProposal = event.payload?.proposal ?? null;
      lastCommitResult = null;
      syncMutationSelection(activeProposal);
      return;
    }

    if (event.event_type === "graph_commit_result") {
      lastCommitResult = event.payload ?? null;
      activeProposal = event.payload?.active_proposal ?? null;
      syncMutationSelection(activeProposal);
      if (event.payload?.result?.status === "applied") {
        dispatch("graphChanged");
      }
      return;
    }

    if (event.event_type === "memory_change_proposal") {
      activeMemoryChange = event.payload?.change ?? null;
      lastMemoryWriteResult = null;
      syncMemorySelection(activeMemoryChange);
      return;
    }

    if (event.event_type === "github_sync_proposal") {
      activeGitHubSync = event.payload?.sync ?? null;
      lastGitHubSyncResult = null;
      syncGitHubSelection(activeGitHubSync);
      return;
    }

    if (event.event_type === "github_sync_result") {
      lastGitHubSyncResult = event.payload ?? null;
      activeGitHubSync = event.payload?.active_github_sync ?? null;
      syncGitHubSelection(activeGitHubSync);
      return;
    }

    if (event.event_type === "memory_write_result") {
      lastMemoryWriteResult = event.payload ?? null;
      activeMemoryChange = event.payload?.active_memory_change ?? null;
      memoryDocument = event.payload?.memory ?? memoryDocument;
      syncMemorySelection(activeMemoryChange);
      return;
    }

    if (event.event_type === "subagent_status" || event.event_type === "subagent_result") {
      const nextRun = event.payload?.run;
      if (!nextRun) {
        return;
      }

      recentSubagentRuns = [nextRun, ...recentSubagentRuns.filter((run) => run.run_id !== nextRun.run_id)].slice(0, 12);
      return;
    }

    if (event.event_type === "agent_start" || event.event_type === "turn_start") {
      isStreaming = true;
      return;
    }

    if (event.event_type === "agent_end" || event.event_type === "turn_end") {
      isStreaming = false;
      return;
    }

    if (event.event_type === "message_start" || event.event_type === "message_update" || event.event_type === "message_end") {
      const payloadMessage = event.payload?.message;
      if (payloadMessage?.role !== "assistant") {
        return;
      }

      appendMessage({
        id: `${event.turn_id || event.event_id}:assistant`,
        role: "assistant",
        content: extractMessageText(payloadMessage),
        timestamp: payloadMessage?.timestamp ? new Date(payloadMessage.timestamp).toISOString() : event.timestamp,
      });
      return;
    }

    if (event.event_type.startsWith("tool_execution_")) {
      const payload = event.payload ?? {};
      const toolName = payload.toolName || "tool";
      const text = payload.partialResult?.content?.map((part) => part?.text || "").filter(Boolean).join("\n") || "";

      toolEvents = [
        ...toolEvents.filter((item) => item.id !== payload.toolCallId),
        {
          id: payload.toolCallId || event.event_id,
          tool_name: toolName,
          status: toToolStatus(event.event_type, payload),
          content: text,
          timestamp: event.timestamp,
        },
      ].slice(-8);
    }
  }

  async function sendPlannerMessage(message, { graphModeOverride = graphMode, clearDraft = false } = {}) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || sending) {
      return false;
    }

    sending = true;
    error = "";

    const optimisticId = `local-user-${Date.now()}`;
    appendMessage({
      id: optimisticId,
      role: "user",
      content: trimmedMessage,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await sendAgentMessage({
        message: trimmedMessage,
        context: {
          graph_mode: graphModeOverride,
          repo: repo.trim() || undefined,
          track: track.trim() || undefined,
        },
      });
      sessionId = response.session_id;
      if (clearDraft) {
        draft = "";
      }
      return true;
    } catch (sendError) {
      messages = messages.filter((entry) => entry.id !== optimisticId);
      error = sendError.message;
      return false;
    } finally {
      sending = false;
    }
  }

  async function submitMessage() {
    await sendPlannerMessage(draft, { clearDraft: true });
  }

  async function approveSelectedMutations() {
    if (!activeProposal || selectedMutationIds.length === 0 || approving) {
      return;
    }

    approving = true;
    error = "";
    try {
      const commitResult = await approveMutationProposal({
        proposal_id: activeProposal.proposal_id,
        approved_mutation_ids: selectedMutationIds,
      });
      lastCommitResult = commitResult;
      activeProposal = commitResult.active_proposal;
      syncMutationSelection(activeProposal);
      if (commitResult.result?.status === "applied") {
        dispatch("graphChanged");
      }
    } catch (approveError) {
      error = approveError.message;
    } finally {
      approving = false;
    }
  }

  async function approveSelectedMemoryEdits() {
    if (!activeMemoryChange || selectedMemoryEditIds.length === 0 || approving) {
      return;
    }

    approving = true;
    error = "";
    try {
      const writeResult = await approveMemoryChange({
        change_id: activeMemoryChange.change_id,
        approved_edit_ids: selectedMemoryEditIds,
      });
      lastMemoryWriteResult = writeResult;
      activeMemoryChange = writeResult.active_memory_change;
      memoryDocument = writeResult.memory ?? memoryDocument;
      syncMemorySelection(activeMemoryChange);
    } catch (approveError) {
      error = approveError.message;
    } finally {
      approving = false;
    }
  }

  async function approveSelectedGitHubOperations() {
    if (!activeGitHubSync || selectedGitHubOperationIds.length === 0 || approving) {
      return;
    }

    approving = true;
    error = "";
    try {
      const syncResult = await approveGitHubSync({
        sync_id: activeGitHubSync.sync_id,
        approved_operation_ids: selectedGitHubOperationIds,
      });
      lastGitHubSyncResult = syncResult;
      activeGitHubSync = syncResult.active_github_sync;
      syncGitHubSelection(activeGitHubSync);
    } catch (approveError) {
      error = approveError.message;
    } finally {
      approving = false;
    }
  }

  async function rejectProposal() {
    if (!activeProposal) {
      return;
    }

    await sendPlannerMessage(`Reject proposal ${activeProposal.proposal_id}. Do not restage the same mutations unchanged. Briefly explain why it was rejected and propose a better alternative if appropriate.`);
  }

  async function reviseProposal() {
    if (!activeProposal) {
      return;
    }

    const revisionNote = draft.trim() || window.prompt("How should the planner revise this proposal?", "");
    if (!revisionNote?.trim()) {
      return;
    }

    const sent = await sendPlannerMessage(
      `Revise proposal ${activeProposal.proposal_id}. Keep the same planning goal, but adjust it as follows: ${revisionNote.trim()}`,
      { clearDraft: draft.trim() === revisionNote.trim() },
    );

    if (sent && draft.trim() === revisionNote.trim()) {
      draft = "";
    }
  }

  async function rejectMemoryChange() {
    if (!activeMemoryChange) {
      return;
    }

    await sendPlannerMessage(`Reject planning memory change ${activeMemoryChange.change_id}. Keep planning memory compact and curated, explain what was wrong, and propose a better targeted edit if appropriate.`);
  }

  async function reviseMemoryChange() {
    if (!activeMemoryChange) {
      return;
    }

    const revisionNote = draft.trim() || window.prompt("How should the planner revise this memory change?", "");
    if (!revisionNote?.trim()) {
      return;
    }

    const sent = await sendPlannerMessage(
      `Revise planning memory change ${activeMemoryChange.change_id}. Keep the same durable memory goal, but adjust it as follows: ${revisionNote.trim()}`,
      { clearDraft: draft.trim() === revisionNote.trim() },
    );

    if (sent && draft.trim() === revisionNote.trim()) {
      draft = "";
    }
  }

  async function rejectGitHubSync() {
    if (!activeGitHubSync) {
      return;
    }

    await sendPlannerMessage(`Reject GitHub sync proposal ${activeGitHubSync.sync_id}. Keep GitHub sync narrow and non-destructive, explain what was wrong, and restage a safer sync if appropriate.`);
  }

  async function reviseGitHubSync() {
    if (!activeGitHubSync) {
      return;
    }

    const revisionNote = draft.trim() || window.prompt("How should the planner revise this GitHub sync?", "");
    if (!revisionNote?.trim()) {
      return;
    }

    const sent = await sendPlannerMessage(
      `Revise GitHub sync proposal ${activeGitHubSync.sync_id} for work item ${activeGitHubSync.work_item_id}. Keep the same sync goal, but adjust it as follows: ${revisionNote.trim()}`,
      { clearDraft: draft.trim() === revisionNote.trim() },
    );

    if (sent && draft.trim() === revisionNote.trim()) {
      draft = "";
    }
  }

  function toggleMutationSelection(mutationId, checked) {
    selectedMutationIds = checked ? [...selectedMutationIds, mutationId] : selectedMutationIds.filter((id) => id !== mutationId);
  }

  function toggleMemorySelection(editId, checked) {
    selectedMemoryEditIds = checked ? [...selectedMemoryEditIds, editId] : selectedMemoryEditIds.filter((id) => id !== editId);
  }

  function toggleGitHubSelection(operationId, checked) {
    selectedGitHubOperationIds = checked ? [...selectedGitHubOperationIds, operationId] : selectedGitHubOperationIds.filter((id) => id !== operationId);
  }

  $: waitingForInitialSnapshot = loading && !hasLoadedSnapshot;

  onMount(() => {
    loadSnapshot();
    stream = connectPlannerStream({
      onOpen: () => {
        connected = true;
      },
      onError: () => {
        connected = false;
      },
      onEvent: handlePlannerEvent,
    });

    return () => stream?.close();
  });
</script>

<section class="planner-chat" class:planner-chat-loading={waitingForInitialSnapshot} aria-busy={waitingForInitialSnapshot}>
  <div class="planner-header">
    <div>
      <h2>Planner chat</h2>
      <p class="muted">Persistent root planner over REST + SSE.</p>
    </div>
    <div class="planner-status">
      <span class:healthy={connected} class="status-pill">{connected ? "stream connected" : "stream reconnecting"}</span>
      {#if sessionId}<code>{sessionId}</code>{/if}
    </div>
  </div>

  {#if waitingForInitialSnapshot}
    <div class="planner-loading-state planner-scroll-region" role="status" aria-live="polite">
      <div>
        <h3>Loading planner workspace…</h3>
        <p class="muted">Waiting for the initial planner session snapshot.</p>
      </div>

      <div class="planner-controls planner-loading-controls" aria-hidden="true">
        {#each [0, 1, 2] as index}
          <div class="planner-loading-field" data-field={index}></div>
        {/each}
      </div>

      <div class="planner-body planner-loading-body" aria-hidden="true">
        <div class="planner-loading-panel planner-loading-transcript">
          <div class="planner-loading-line planner-loading-line-long"></div>
          <div class="planner-loading-line"></div>
          <div class="planner-loading-line planner-loading-line-short"></div>
          <div class="planner-loading-bubble"></div>
          <div class="planner-loading-bubble planner-loading-bubble-accent"></div>
        </div>
        <div class="planner-loading-panel planner-loading-tools">
          <div class="planner-loading-line"></div>
          <div class="planner-loading-line planner-loading-line-short"></div>
          <div class="planner-loading-card"></div>
          <div class="planner-loading-card"></div>
        </div>
      </div>
    </div>
  {:else}
    <div class="planner-controls">
      <label>
        Graph mode
        <select bind:value={graphMode}>
          {#each graphModes as mode}<option value={mode}>{mode}</option>{/each}
        </select>
      </label>
      <label>
        Repo filter
        <input bind:value={repo} placeholder="fusupo/escapement-studio" />
      </label>
      <label>
        Track filter
        <input bind:value={track} placeholder="track:foundation" />
      </label>
    </div>

    <div class="planner-scroll-region">
      {#if error}<div class="banner error inline-banner">{error}</div>{/if}

      {#if lastCommitResult}
      <div class="banner {lastCommitResult.result.status === 'applied' ? 'success' : 'error'} inline-banner">
        {#if lastCommitResult.result.status === 'applied'}
          Applied {lastCommitResult.approved_mutation_ids.length} mutation(s) from {lastCommitResult.proposal_id}. Graph version {lastCommitResult.result.previous_graph_version} → {lastCommitResult.result.new_graph_version}.
        {:else if lastCommitResult.result.status === 'stale'}
          Proposal {lastCommitResult.proposal_id} is stale. Current graph version: {lastCommitResult.result.current_graph_version}.
        {:else}
          Commit failed for proposal {lastCommitResult.proposal_id}: {lastCommitResult.result.errors.map((item) => item.message).join('; ')}
        {/if}
      </div>
      {/if}

      {#if lastMemoryWriteResult}
      <div class="banner {lastMemoryWriteResult.result.status === 'applied' ? 'success' : 'error'} inline-banner">
        {#if lastMemoryWriteResult.result.status === 'applied'}
          Applied {lastMemoryWriteResult.approved_edit_ids.length} planning memory edit(s). Memory hash {lastMemoryWriteResult.result.previous_content_hash.slice(0, 8)} → {lastMemoryWriteResult.result.new_content_hash.slice(0, 8)}.
        {:else if lastMemoryWriteResult.result.status === 'stale'}
          Memory change {lastMemoryWriteResult.change_id} is stale. Current memory hash: {lastMemoryWriteResult.result.current_content_hash.slice(0, 8)}.
        {:else}
          Memory write failed: {lastMemoryWriteResult.result.errors.map((item) => item.message).join('; ')}
        {/if}
      </div>
      {/if}

      {#if lastGitHubSyncResult}
      <div class="banner {lastGitHubSyncResult.result.status === 'applied' ? 'success' : 'error'} inline-banner">
        {#if lastGitHubSyncResult.result.status === 'applied'}
          Applied {lastGitHubSyncResult.approved_operation_ids.length} GitHub sync operation(s). Body hash {lastGitHubSyncResult.result.previous_body_hash.slice(0, 8)} → {lastGitHubSyncResult.result.new_body_hash.slice(0, 8)}.
        {:else if lastGitHubSyncResult.result.status === 'stale'}
          GitHub sync {lastGitHubSyncResult.sync_id} is stale. Current body hash: {lastGitHubSyncResult.result.current_body_hash.slice(0, 8)}.
        {:else}
          GitHub sync failed: {lastGitHubSyncResult.result.errors.map((item) => item.message).join('; ')}
        {/if}
      </div>
      {/if}

      <div class="planner-body">
    <div class="planner-transcript">
      {#if loading}
        <div class="empty-state compact">Loading planner transcript…</div>
      {:else if messages.length === 0}
        <div class="empty-state compact">No planner messages yet. Send the first prompt from the browser.</div>
      {:else}
        {#each messages as message}
          <article class="chat-entry {message.role}">
            <div class="chat-entry-meta">
              <strong>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Planner' : message.tool_name || 'Tool'}</strong>
              <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
            </div>
            <pre>{message.content || (message.role === 'assistant' && isStreaming ? '…' : '')}</pre>
          </article>
        {/each}
      {/if}
    </div>

    <aside class="planner-tools">
      <div>
        <h3>Tool activity</h3>
        <p class="muted">Live SDK-native tool execution events.</p>
      </div>
      {#if toolEvents.length === 0}
        <p class="muted">Tool activity will appear here during planner turns.</p>
      {:else}
        <ul class="tool-activity-list">
          {#each toolEvents as toolEvent}
            <li>
              <div class="chat-entry-meta">
                <strong>{toolEvent.tool_name}</strong>
                <span>{new Date(toolEvent.timestamp).toLocaleTimeString()}</span>
              </div>
              <p>{toolEvent.status}</p>
              {#if toolEvent.content}<pre>{toolEvent.content}</pre>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </aside>
    </div>

    <section class="proposal-panel">
    <div class="proposal-header">
      <div>
        <h3>Active mutation proposal</h3>
        <p class="muted">Latest structured graph proposal emitted by the planner.</p>
      </div>
      {#if activeProposal?.context?.based_on_graph_version}<span class="status-pill healthy">graph v{activeProposal.context.based_on_graph_version}</span>{/if}
    </div>

    {#if !activeProposal}
      <p class="muted">No active graph proposal yet.</p>
    {:else}
      <div class="proposal-summary">
        <strong>{activeProposal.proposal_id}</strong>
        <p>{activeProposal.summary}</p>
      </div>
      <div class="proposal-list">
        {#each activeProposal.mutations as mutation}
          <label class="proposal-card">
            <div class="proposal-card-header">
              <input type="checkbox" checked={selectedMutationIds.includes(mutation.id)} on:change={(event) => toggleMutationSelection(mutation.id, event.currentTarget.checked)} />
              <div>
                <strong>{mutation.id}</strong>
                <span class="proposal-type">{mutation.type}</span>
                {#if mutation.entity_id}<code>{mutation.entity_id}</code>{/if}
              </div>
            </div>
            <p>{mutation.rationale}</p>
            {#if mutation.payload}<pre>{JSON.stringify(mutation.payload, null, 2)}</pre>{/if}
          </label>
        {/each}
      </div>
      <div class="planner-actions proposal-actions">
        <button on:click={approveSelectedMutations} disabled={approving || selectedMutationIds.length === 0}>{approving ? 'Applying...' : `Approve ${selectedMutationIds.length} selected`}</button>
        <button class="secondary" on:click={rejectProposal} disabled={sending}>Reject via follow-up</button>
        <button class="secondary" on:click={reviseProposal} disabled={sending}>Revise via follow-up</button>
      </div>
    {/if}
    </section>

    <section class="proposal-panel memory-panel">
    <div class="proposal-header">
      <div>
        <h3>Planning memory</h3>
        <p class="muted">Curated durable memory from <code>PLANNING_MEMORY.md</code>.</p>
      </div>
      {#if memoryDocument}<span class="status-pill">{memoryDocument.content_hash.slice(0, 8)}</span>{/if}
    </div>

    {#if memoryDocument}
      <details class="memory-preview">
        <summary>Current planning memory</summary>
        <pre>{memoryDocument.content}</pre>
      </details>
    {/if}

    {#if !activeMemoryChange}
      <p class="muted">No staged planning memory change yet.</p>
    {:else}
      <div class="proposal-summary">
        <strong>{activeMemoryChange.change_id}</strong>
        <p>{activeMemoryChange.summary}</p>
      </div>
      <div class="proposal-list">
        {#each activeMemoryChange.edits as edit}
          <label class="proposal-card memory-edit-card">
            <div class="proposal-card-header">
              <input type="checkbox" checked={selectedMemoryEditIds.includes(edit.id)} on:change={(event) => toggleMemorySelection(edit.id, event.currentTarget.checked)} />
              <div>
                <strong>{edit.id}</strong>
                <span class="proposal-type">{edit.kind}</span>
                {#if edit.target_heading}<code>{edit.target_heading}</code>{/if}
              </div>
            </div>
            <strong>{edit.summary}</strong>
            <p>{edit.rationale}</p>
            {#if edit.old_text}
              <div>
                <div class="muted">Old text</div>
                <pre>{edit.old_text}</pre>
              </div>
            {/if}
            {#if edit.new_text}
              <div>
                <div class="muted">New text</div>
                <pre>{edit.new_text}</pre>
              </div>
            {/if}
          </label>
        {/each}
      </div>
      <div class="planner-actions proposal-actions">
        <button on:click={approveSelectedMemoryEdits} disabled={approving || selectedMemoryEditIds.length === 0}>{approving ? 'Applying...' : `Approve ${selectedMemoryEditIds.length} memory edit(s)`}</button>
        <button class="secondary" on:click={rejectMemoryChange} disabled={sending}>Reject via follow-up</button>
        <button class="secondary" on:click={reviseMemoryChange} disabled={sending}>Revise via follow-up</button>
      </div>
    {/if}
    </section>

    <section class="proposal-panel github-sync-panel">
    <div class="proposal-header">
      <div>
        <h3>GitHub sync</h3>
        <p class="muted">Approval-gated issue sync proposals for the managed <code>studio-sync</code> block.</p>
      </div>
      {#if activeGitHubSync}<span class="status-pill">{activeGitHubSync.issue.repo} #{activeGitHubSync.issue.issue_number}</span>{/if}
    </div>

    {#if !activeGitHubSync}
      <p class="muted">No staged GitHub sync proposal yet.</p>
    {:else}
      <div class="proposal-summary">
        <strong>{activeGitHubSync.sync_id}</strong>
        <p>{activeGitHubSync.summary}</p>
      </div>
      <div class="proposal-list">
        {#each activeGitHubSync.operations as operation}
          <label class="proposal-card github-sync-card">
            <div class="proposal-card-header">
              <input type="checkbox" checked={selectedGitHubOperationIds.includes(operation.id)} on:change={(event) => toggleGitHubSelection(operation.id, event.currentTarget.checked)} />
              <div>
                <strong>{operation.id}</strong>
                <span class="proposal-type">{operation.kind}</span>
              </div>
            </div>
            <strong>{operation.summary}</strong>
            <p>{operation.rationale}</p>
            <div class="sync-preview-grid">
              <div>
                <div class="muted">Current block</div>
                <pre>{operation.preview.before}</pre>
              </div>
              <div>
                <div class="muted">Proposed block</div>
                <pre>{operation.preview.after}</pre>
              </div>
            </div>
          </label>
        {/each}
      </div>
      <div class="planner-actions proposal-actions">
        <button on:click={approveSelectedGitHubOperations} disabled={approving || selectedGitHubOperationIds.length === 0}>{approving ? 'Applying...' : `Approve ${selectedGitHubOperationIds.length} sync operation(s)`}</button>
        <button class="secondary" on:click={rejectGitHubSync} disabled={sending}>Reject via follow-up</button>
        <button class="secondary" on:click={reviseGitHubSync} disabled={sending}>Revise via follow-up</button>
      </div>
    {/if}
    </section>

    <section class="proposal-panel subagent-panel">
    <div class="proposal-header">
      <div>
        <h3>Recent specialist runs</h3>
        <p class="muted">Ephemeral code-crawler, scope-predictor, and reconciliation-analyst runs delegated by the planner.</p>
      </div>
    </div>

    {#if recentSubagentRuns.length === 0}
      <p class="muted">No specialist runs yet.</p>
    {:else}
      <div class="proposal-list">
        {#each recentSubagentRuns as run}
          <article class="proposal-card subagent-card">
            <div class="proposal-card-header">
              <div>
                <strong>{run.agent_type}</strong>
                <span class="proposal-type">{run.status}</span>
                <code>{run.run_id}</code>
              </div>
            </div>
            <p>{run.task}</p>
            {#if run.progress_message}<p class="muted">{run.progress_message}</p>{/if}
            {#if run.result}
              <p><strong>{run.result.summary}</strong></p>
              <p class="muted">Confidence: {run.result.confidence}</p>
              {#if run.result.findings?.length}
                <ul class="subagent-findings">
                  {#each run.result.findings.slice(0, 4) as finding}
                    <li>
                      <strong>{finding.kind}</strong>
                      {#if finding.file}<code>{finding.file}{finding.lines ? `:${finding.lines}` : ''}</code>{/if}
                      <div>{finding.summary || '(no summary)'}</div>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
            <p class="muted">Artifacts: <code>{run.artifact_dir}</code></p>
          </article>
        {/each}
      </div>
    {/if}
    </section>

    </div>

    <div class="planner-composer">
      <label>
        Message
        <textarea bind:value={draft} rows="2" placeholder="Ask the planner to inspect the graph, delegate specialists, review reconciliation drift, propose memory updates, or explain blockers."></textarea>
      </label>
      <div class="planner-actions">
        <button class="secondary" on:click={loadSnapshot} disabled={loading}>Refresh transcript</button>
        <button on:click={submitMessage} disabled={sending || !draft.trim()}>{sending ? 'Sending...' : isStreaming ? 'Queue follow-up' : 'Send to planner'}</button>
      </div>
    </div>
  {/if}
</section>

<style>
  /* Parent (.col-chat) controls height; we just fill it */
</style>
