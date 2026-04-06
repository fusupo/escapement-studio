import { Inject, Injectable } from "@nestjs/common";
import type { AgentSession, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { queryBlocked, queryFrontier } from "../../lib/manifest-core.js";
import { EdgesService } from "../graph/edges.service.js";
import { SQLiteService } from "../graph/sqlite.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { EdgeRecord, WorkItemRecord } from "../graph/types.js";
import { MemoryService } from "./memory.service.js";
import type {
  AssemblePlanningContextInput,
  PlanningContext,
  PlanningContextDocument,
  PlanningContextGraph,
  PlanningContextGraphMode,
  PlanningContextMessage,
  PlanningContextTriple,
} from "./types.js";

@Injectable()
export class ContextService {
  private readonly overviewPath = resolve(process.cwd(), "STUDIO_OVERVIEW.md");
  private readonly architecturePath = resolve(process.cwd(), "STUDIO_ARCHITECTURE.md");
  private readonly planningMemoryPath = resolve(process.cwd(), "PLANNING_MEMORY.md");
  private readonly documentCharLimit = 3200;
  private readonly conversationWindowSize = 8;

  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(EdgesService) private readonly edges: EdgesService,
    @Inject(MemoryService) private readonly memoryService: MemoryService,
  ) {}

  assemble(input: AssemblePlanningContextInput = {}): PlanningContext {
    const graph = this.buildGraphContext(input);

    return {
      generated_at: this.now(),
      documents: [
        this.readDocument("studio_overview", this.overviewPath),
        this.readDocument("studio_architecture", this.architecturePath),
        this.readPlanningMemoryDocument(),
      ],
      graph,
      conversation_window: this.buildConversationWindow(input.session),
    };
  }

  formatForPrompt(context: PlanningContext, userMessage: string): string {
    const documents = context.documents
      .map((document) => `### ${document.label}\n${document.content}`)
      .join("\n\n");

    const triples = context.graph.triples
      .map((triple) => `- (${triple.subject}, ${triple.predicate}, ${triple.object})`)
      .join("\n");

    const conversation = context.conversation_window.length === 0
      ? "- (no recent conversation window)"
      : context.conversation_window
          .map((message) => `- ${message.role}: ${message.content}`)
          .join("\n");

    const filters = [
      context.graph.filters.repo ? `repo=${context.graph.filters.repo}` : null,
      context.graph.filters.track ? `track=${context.graph.filters.track}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    return [
      "<studio_context>",
      `generated_at: ${context.generated_at}`,
      `graph_mode: ${context.graph.mode}`,
      `graph_summary: ${context.graph.item_count} items, ${context.graph.edge_count} edges, ${context.graph.triple_count} triples`,
      `graph_filters: ${filters || "none"}`,
      "",
      "## Vision docs + planning memory",
      documents,
      "",
      "## Graph triples",
      triples || "- (no graph triples)",
      "",
      "## Recent conversation window",
      conversation,
      "</studio_context>",
      "",
      "<user_message>",
      userMessage.trim(),
      "</user_message>",
    ].join("\n");
  }

  private buildGraphContext(input: AssemblePlanningContextInput): PlanningContextGraph {
    const mode = input.graph_mode ?? "default";
    const allItems = this.workItems.list();
    const allEdges = this.edges.list();

    const includedIds = mode === "full"
      ? new Set(allItems.map((item) => item.id))
      : mode === "focused"
        ? this.buildFocusedSlice(allItems, allEdges, input)
        : this.buildDefaultSlice(allItems, allEdges);

    const items = allItems.filter((item) => includedIds.has(item.id));
    const edges = allEdges.filter((edge) => includedIds.has(edge.from_id) && includedIds.has(edge.to_id));
    const triples = this.serializeTriples(items, edges);

    return {
      mode,
      filters: {
        repo: input.repo,
        track: input.track,
      },
      item_count: items.length,
      edge_count: edges.length,
      triple_count: triples.length,
      triples,
    };
  }

  private buildDefaultSlice(allItems: WorkItemRecord[], allEdges: EdgeRecord[]): Set<string> {
    const byId = new Map(allItems.map((item) => [item.id, item]));
    const includedIds = new Set<string>();
    const seedIds = new Set<string>();

    for (const item of queryFrontier(this.sqlite.getDb())) {
      if (byId.has(item.id)) {
        seedIds.add(item.id);
      }
    }

    for (const item of queryBlocked(this.sqlite.getDb())) {
      if (byId.has(item.id)) {
        seedIds.add(item.id);
      }
    }

    for (const id of seedIds) {
      includedIds.add(id);
    }

    for (const edge of allEdges) {
      if (edge.rel === "depends_on" || edge.rel === "implemented_by") {
        if (seedIds.has(edge.from_id) || seedIds.has(edge.to_id)) {
          includedIds.add(edge.from_id);
          includedIds.add(edge.to_id);
        }
      }

      if (edge.rel === "is_part_of") {
        if (seedIds.has(edge.from_id) || seedIds.has(edge.to_id)) {
          includedIds.add(edge.from_id);
          includedIds.add(edge.to_id);
        }
      }
    }

    return includedIds;
  }

  private buildFocusedSlice(
    allItems: WorkItemRecord[],
    allEdges: EdgeRecord[],
    input: AssemblePlanningContextInput,
  ): Set<string> {
    const includedIds = new Set<string>();

    for (const item of allItems) {
      const repoMatches = input.repo ? item.repo === input.repo : true;
      const trackMatches = input.track ? false : true;

      if (repoMatches && trackMatches) {
        includedIds.add(item.id);
      }
    }

    if (input.track) {
      includedIds.add(input.track);

      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of allEdges) {
          if (edge.rel !== "is_part_of") {
            continue;
          }

          if (includedIds.has(edge.to_id) && !includedIds.has(edge.from_id)) {
            const candidate = allItems.find((item) => item.id === edge.from_id);
            if (!candidate) {
              continue;
            }

            if (!input.repo || candidate.repo === input.repo || candidate.id === input.track) {
              includedIds.add(edge.from_id);
              changed = true;
            }
          }
        }
      }
    }

    return includedIds;
  }

  private serializeTriples(items: WorkItemRecord[], edges: EdgeRecord[]): PlanningContextTriple[] {
    const triples: PlanningContextTriple[] = [];

    for (const item of items) {
      triples.push(
        { subject: item.id, predicate: "kind", object: item.kind },
        { subject: item.id, predicate: "name", object: item.name },
        { subject: item.id, predicate: "state", object: item.state },
      );

      if (item.repo) {
        triples.push({ subject: item.id, predicate: "repo", object: item.repo });
      }
    }

    for (const edge of edges) {
      triples.push({ subject: edge.from_id, predicate: edge.rel, object: edge.to_id });
    }

    return triples;
  }

  private buildConversationWindow(session?: AgentSession): PlanningContextMessage[] {
    if (!session) {
      return [];
    }

    const entries = session.sessionManager.getEntries();
    const recentMessages = entries
      .filter((entry): entry is SessionMessageEntry => entry.type === "message")
      .slice(-this.conversationWindowSize);

    return recentMessages.map((entry) => ({
      role: entry.message.role,
      content: this.messageToText(entry),
      timestamp: entry.timestamp,
    }));
  }

  private messageToText(entry: SessionMessageEntry): string {
    const message = entry.message as unknown as Record<string, unknown>;
    const content = message["content"];

    if (typeof content === "string") {
      return this.compact(content, 500);
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
            return typeof part.text === "string" ? part.text : "";
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");

      return this.compact(text || "(non-text content)", 500);
    }

    return this.compact(JSON.stringify(message), 500);
  }

  private readDocument(kind: PlanningContextDocument["kind"], path: string): PlanningContextDocument {
    const content = readFileSync(path, "utf8");
    return {
      kind,
      label: this.getDocumentLabel(kind),
      path,
      content: this.compact(content, this.documentCharLimit),
    };
  }

  private readPlanningMemoryDocument(): PlanningContextDocument {
    const memory = this.memoryService.read();
    return {
      kind: "planning_memory",
      label: this.getDocumentLabel("planning_memory"),
      path: memory.path,
      content: this.compact(memory.content, this.documentCharLimit),
    };
  }

  private getDocumentLabel(kind: PlanningContextDocument["kind"]): string {
    switch (kind) {
      case "studio_overview":
        return "Studio overview";
      case "studio_architecture":
        return "Studio architecture";
      case "planning_memory":
        return "Planning memory";
    }
  }

  private compact(value: string, maxChars: number): string {
    const normalized = value.replace(/\r/g, "").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated]`;
  }

  private now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}
