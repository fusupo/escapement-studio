<script>
  import { onMount } from "svelte";
  import { getPlannerSessionSnapshot, sendAgentMessage } from "../lib/api.js";
  import { connectPlannerStream, extractMessageText, toToolStatus } from "../lib/planner-chat.js";

  const graphModes = ["default", "focused", "full"];

  let draft = "";
  let graphMode = "default";
  let repo = "";
  let track = "";
  let messages = [];
  let toolEvents = [];
  let loading = true;
  let sending = false;
  let connected = false;
  let error = "";
  let sessionId = "";
  let isStreaming = false;
  let stream;

  function mergeSnapshot(snapshot) {
    sessionId = snapshot.session_id;
    isStreaming = snapshot.is_streaming;
    messages = snapshot.messages ?? [];
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

  async function submitMessage() {
    const message = draft.trim();
    if (!message || sending) {
      return;
    }

    sending = true;
    error = "";

    const optimisticId = `local-user-${Date.now()}`;
    appendMessage({
      id: optimisticId,
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await sendAgentMessage({
        message,
        context: {
          graph_mode: graphMode,
          repo: repo.trim() || undefined,
          track: track.trim() || undefined,
        },
      });
      sessionId = response.session_id;
      draft = "";
    } catch (sendError) {
      messages = messages.filter((entry) => entry.id !== optimisticId);
      error = sendError.message;
    } finally {
      sending = false;
    }
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
