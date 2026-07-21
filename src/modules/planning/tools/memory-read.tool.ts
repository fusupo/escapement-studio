import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PlanningToolDeps } from "./types.js";

export function createMemoryReadTool(deps: PlanningToolDeps) {
  return defineTool({
    name: "memory_read",
    label: "Planning Memory Read",
    description: "Read the curated durable planning memory file.",
    promptSnippet: "memory_read: inspect the curated planning memory before proposing durable memory changes.",
    promptGuidelines: [
      "Use memory_read before suggesting durable planning-memory edits so you can update the existing curated structure intentionally.",
    ],
    parameters: Type.Object({}),
    execute: async () => {
      const memory = deps.memoryService.read();
      return {
        content: [{ type: "text", text: memory.content }],
        details: memory,
      };
    },
  });
}
