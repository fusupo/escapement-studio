export function connectPlannerStream({ onEvent, onOpen, onError } = {}) {
  const stream = new EventSource("/api/agent/stream");

  const forward = (eventType) => {
    stream.addEventListener(eventType, (event) => {
      try {
        const payload = JSON.parse(event.data);
        onEvent?.(payload);
      } catch (error) {
        console.error(`Failed to parse planner event ${eventType}`, error);
      }
    });
  };

  [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "mutation_proposal",
    "graph_commit_result",
    "memory_change_proposal",
    "memory_write_result",
  ].forEach(forward);

  stream.onopen = () => onOpen?.();
  stream.onerror = (error) => onError?.(error);

  return stream;
}

export function extractMessageText(message) {
  const content = message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (part?.type === "text") {
        return part.text ?? "";
      }

      if (part?.type === "thinking") {
        return part.thinking ?? "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function toToolStatus(eventType, payload = {}) {
  const toolName = payload.toolName || "tool";

  if (eventType === "tool_execution_start") {
    return `${toolName} running…`;
  }

  if (eventType === "tool_execution_update") {
    return `${toolName} updating…`;
  }

  if (eventType === "tool_execution_end") {
    return `${toolName} finished`;
  }

  return toolName;
}
