<script>
  import { createEventDispatcher, onMount } from "svelte";
  import { approveMutationProposal, getPlannerSessionSnapshot, sendAgentMessage } from "../lib/api.js";
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
  let stream;

  function syncSelection(proposal, preserve = false) {
    if (!proposal) {
      selectedMutationIds = [];
      return;
    }

    const ids = proposal.mutations?.map((mutation) => mutation.id) ?? [];
    selectedMutationIds = preserve
      ? selectedMutationIds.filter((id) => ids.includes(id))
      : ids;
  }

  function mergeSnapshot(snapshot) {
    sessionId = snapshot.session_id;
    isStreaming = snapshot.is_streaming;
    messages = snapshot.messages ?? [];
    lastCommitResult = snapshot.last_commit_result ?? null;

    const nextProposal = snapshot.active_proposal ?? null;
    const changedProposal = nextProposal?.proposal_id !== activeProposal?.proposal_id;
    activeProposal = nextProposal;
    syncSelection(activeProposal, !changedProposal);
  }

  async function loadSnapshot() {
    loading = true;
    error = "";

    try {
      mergeSnapshot(await getPlannerSessionSnapshot());
    } catch (loadError) {
      error = loadError.message;
    } finally {
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
      syncSelection(activeProposal);
      return;
    }

    if (event.event_type === "graph_commit_result") {
      lastCommitResult = event.payload ?? null;
      activeProposal = event.payload?.active_proposal ?? null;
      syncSelection(activeProposal);

      if (event.payload?.result?.status === "applied") {
        dispatch("graphChanged");
      }
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
      const role = payloadMessage?.role;

      if (role !== "assistant") {
        return;
      }

      appendMessage({
        id: `${event.turn_id || event.event_id}:assistant`,
        role: "assistant",
        content: extractMessageText(payloadMessage),
        timestamp: payloadMessage?.timestamp
          ? new Date(payloadMessage.timestamp).toISOString()
          : event.timestamp,
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
      syncSelection(activeProposal);

      if (commitResult.result?.status === "applied") {
        dispatch("graphChanged");
      }
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

    await sendPlannerMessage(
      `Reject proposal ${activeProposal.proposal_id}. Do not restage the same mutations unchanged. Briefly explain why it was rejected and propose a better alternative if appropriate.`,
    );
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

  function toggleMutationSelection(mutationId, checked) {
    selectedMutationIds = checked
      ? [...selectedMutationIds, mutationId]
      : selectedMutationIds.filter((id) => id !== mutationId);
  }

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

<section class="card planner-chat">
  <div class="planner-header">
    <div>
      <h2>Planner chat</h2>
      <p class="muted">Persistent root planner over REST + SSE.</p>
    </div>
    <div class="planner-status">
      <span class:healthy={connected} class="status-pill">{connected ? "stream connected" : "stream reconnecting"}</span>
      {#if sessionId}
        <code>{sessionId}</code>
      {/if}
    </div>
  </div>

  <div class="planner-controls">
    <label>
      Graph mode
      <select bind:value={graphMode}>
        {#each graphModes as mode}
          <option value={mode}>{mode}</option>
        {/each}
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

  {#if error}
    <div class="banner error inline-banner">{error}</div>
  {/if}

  {#if lastCommitResult}
    <div class="banner {lastCommitResult.result.status === 'applied' ? 'success' : 'error'} inline-banner">
      {#if lastCommitResult.result.status === 'applied'}
        Applied {lastCommitResult.approved_mutation_ids.length} mutation(s) from {lastCommitResult.proposal_id}. Graph version {lastCommitResult.result.previous_graph_version} → {lastCommitResult.result.new_graph_version}.
      {:else if lastCommitResult.result.status === 'stale'}
        Proposal {lastCommitResult.proposal_id} is stale. Current graph version: {lastCommitResult.result.current_graph_version}.
      {:else}
        Commit failed for proposal {lastCommitResult.proposal_id}: {lastCommitResult.result.errors.map((error) => error.message).join('; ')}
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
              <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "Planner" : message.tool_name || "Tool"}</strong>
              <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
            </div>
            <pre>{message.content || (message.role === "assistant" && isStreaming ? "…" : "")}</pre>
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
              {#if toolEvent.content}
                <pre>{toolEvent.content}</pre>
              {/if}
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
        <p class="muted">Latest structured proposal emitted by the planner.</p>
      </div>
      {#if activeProposal?.context?.based_on_graph_version}
        <span class="status-pill healthy">graph v{activeProposal.context.based_on_graph_version}</span>
      {/if}
    </div>

    {#if !activeProposal}
      <p class="muted">No active proposal yet. Ask the planner to propose graph mutations.</p>
    {:else}
      <div class="proposal-summary">
        <strong>{activeProposal.proposal_id}</strong>
        <p>{activeProposal.summary}</p>
      </div>

      <div class="proposal-list">
        {#each activeProposal.mutations as mutation}
          <label class="proposal-card">
            <div class="proposal-card-header">
              <input
                type="checkbox"
                checked={selectedMutationIds.includes(mutation.id)}
                on:change={(event) => toggleMutationSelection(mutation.id, event.currentTarget.checked)}
              />
              <div>
                <strong>{mutation.id}</strong>
                <span class="proposal-type">{mutation.type}</span>
                {#if mutation.entity_id}
                  <code>{mutation.entity_id}</code>
                {/if}
              </div>
            </div>
            <p>{mutation.rationale}</p>
            {#if mutation.payload}
              <pre>{JSON.stringify(mutation.payload, null, 2)}</pre>
            {/if}
          </label>
        {/each}
      </div>

      <div class="planner-actions proposal-actions">
        <button on:click={approveSelectedMutations} disabled={approving || selectedMutationIds.length === 0}>
          {approving ? "Applying..." : `Approve ${selectedMutationIds.length} selected`}
        </button>
        <button class="secondary" on:click={rejectProposal} disabled={sending}>Reject via follow-up</button>
        <button class="secondary" on:click={reviseProposal} disabled={sending}>Revise via follow-up</button>
      </div>
    {/if}
  </section>

  <div class="planner-composer">
    <label>
      Message
      <textarea bind:value={draft} rows="4" placeholder="Ask the planner to inspect the graph, explain blockers, or propose next work."></textarea>
    </label>
    <div class="planner-actions">
      <button class="secondary" on:click={loadSnapshot} disabled={loading}>Refresh transcript</button>
      <button on:click={submitMessage} disabled={sending || !draft.trim()}>{sending ? "Sending..." : isStreaming ? "Queue follow-up" : "Send to planner"}</button>
    </div>
  </div>
</section>
