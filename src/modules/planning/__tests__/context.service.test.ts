import { describe, it, expect } from "vitest";
import type { WorkItemRecord, EdgeRecord } from "../../graph/types.js";
import type { PlanningContext, PlanningContextTriple } from "../types.js";

/**
 * We test the pure logic from ContextService without NestJS DI.
 * Extract the algorithms into standalone functions here mirroring the service.
 */

function serializeTriples(items: WorkItemRecord[], edges: EdgeRecord[]): PlanningContextTriple[] {
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

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\r/g, "").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function formatForPrompt(context: PlanningContext, userMessage: string): string {
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

// Helpers
function makeItem(overrides: Partial<WorkItemRecord> & { id: string }): WorkItemRecord {
  return {
    name: overrides.id,
    kind: "issue",
    state: "planned",
    repo: null,
    issue_number: null,
    issue_url: null,
    scope_hint: null,
    branch: null,
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEdge(from_id: string, rel: EdgeRecord["rel"], to_id: string): EdgeRecord {
  return { id: 1, from_id, rel, to_id, confidence: "certain", meta: {}, created_at: "2026-01-01T00:00:00Z" };
}

describe("serializeTriples", () => {
  it("produces kind/name/state triples for each item", () => {
    const items = [makeItem({ id: "a", name: "Alpha", kind: "issue", state: "planned" })];
    const triples = serializeTriples(items, []);

    expect(triples).toEqual([
      { subject: "a", predicate: "kind", object: "issue" },
      { subject: "a", predicate: "name", object: "Alpha" },
      { subject: "a", predicate: "state", object: "planned" },
    ]);
  });

  it("includes repo triple when present", () => {
    const items = [makeItem({ id: "b", repo: "my-repo" })];
    const triples = serializeTriples(items, []);

    expect(triples).toHaveLength(4);
    expect(triples[3]).toEqual({ subject: "b", predicate: "repo", object: "my-repo" });
  });

  it("omits repo triple when null", () => {
    const items = [makeItem({ id: "c", repo: null })];
    const triples = serializeTriples(items, []);
    expect(triples).toHaveLength(3);
  });

  it("includes edge triples", () => {
    const items = [makeItem({ id: "x" }), makeItem({ id: "y" })];
    const edges = [makeEdge("x", "depends_on", "y")];
    const triples = serializeTriples(items, edges);

    const edgeTriple = triples.find((t) => t.predicate === "depends_on");
    expect(edgeTriple).toEqual({ subject: "x", predicate: "depends_on", object: "y" });
  });
});

describe("compact", () => {
  it("returns full string when under limit", () => {
    expect(compact("hello world", 100)).toBe("hello world");
  });

  it("truncates and appends marker when over limit", () => {
    const long = "a".repeat(200);
    const result = compact(long, 50);
    expect(result).toContain("...[truncated]");
    expect(result.length).toBeLessThan(200);
  });

  it("trims whitespace", () => {
    expect(compact("  hello  ", 100)).toBe("hello");
  });

  it("normalizes carriage returns", () => {
    expect(compact("line1\r\nline2", 100)).toBe("line1\nline2");
  });

  it("handles exact-limit string", () => {
    const exact = "a".repeat(50);
    expect(compact(exact, 50)).toBe(exact);
  });
});

describe("formatForPrompt", () => {
  const context: PlanningContext = {
    generated_at: "2026-01-01T00:00:00Z",
    documents: [
      { kind: "studio_overview", label: "Studio overview", path: "/test", content: "overview content" },
    ],
    graph: {
      mode: "default",
      filters: {},
      item_count: 1,
      edge_count: 0,
      triple_count: 3,
      triples: [
        { subject: "a", predicate: "kind", object: "issue" },
        { subject: "a", predicate: "name", object: "Alpha" },
        { subject: "a", predicate: "state", object: "planned" },
      ],
    },
    conversation_window: [],
  };

  it("wraps output in studio_context tags", () => {
    const result = formatForPrompt(context, "hello");
    expect(result).toMatch(/^<studio_context>/);
    expect(result).toContain("</studio_context>");
  });

  it("wraps user message in user_message tags", () => {
    const result = formatForPrompt(context, "hello");
    expect(result).toContain("<user_message>\nhello\n</user_message>");
  });

  it("includes graph summary line", () => {
    const result = formatForPrompt(context, "test");
    expect(result).toContain("graph_summary: 1 items, 0 edges, 3 triples");
  });

  it("renders triples as parenthesized tuples", () => {
    const result = formatForPrompt(context, "test");
    expect(result).toContain("- (a, kind, issue)");
    expect(result).toContain("- (a, name, Alpha)");
  });

  it("shows no conversation window placeholder when empty", () => {
    const result = formatForPrompt(context, "test");
    expect(result).toContain("- (no recent conversation window)");
  });

  it("shows filters when provided", () => {
    const withFilters = {
      ...context,
      graph: { ...context.graph, filters: { repo: "my-repo" } },
    };
    const result = formatForPrompt(withFilters, "test");
    expect(result).toContain("graph_filters: repo=my-repo");
  });

  it("shows 'none' when no filters", () => {
    const result = formatForPrompt(context, "test");
    expect(result).toContain("graph_filters: none");
  });
});
