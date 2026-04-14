import { describe, expect, it } from "vitest";
import { initManifest } from "../../../lib/manifest-core.js";
import { GraphService } from "../graph.service.js";
import { GraphWriterService } from "../graph-writer.service.js";
import { SQLiteService } from "../../../platform/sqlite.service.js";
import type { WorkItemState } from "../types.js";
import { WorkItemsService } from "../work-items.service.js";

const SUPPORTED_STATES: WorkItemState[] = [
  "planned",
  "drafting",
  "ready",
  "in_progress",
  "run_errored",
  "open_pr",
  "merged_pr",
  "closed",
  "deferred",
  "done",
  "archived",
  "cancelled",
];

function createServices() {
  const db = initManifest(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO studio_metadata (key, value) VALUES ('graph_version', '0');
  `);

  const sqlite = Object.create(SQLiteService.prototype) as SQLiteService;
  Object.defineProperty(sqlite, "db", { value: db, writable: false });
  (SQLiteService.prototype as unknown as { migrateWorkItemStates: () => void }).migrateWorkItemStates.call(sqlite);

  const graphWriter = Object.create(GraphWriterService.prototype) as GraphWriterService;
  Object.defineProperty(graphWriter, "sqlite", { value: sqlite, writable: false });

  const workItems = Object.create(WorkItemsService.prototype) as WorkItemsService;
  Object.defineProperty(workItems, "sqlite", { value: sqlite, writable: false });
  Object.defineProperty(workItems, "graphWriter", { value: graphWriter, writable: false });

  const graph = Object.create(GraphService.prototype) as GraphService;
  Object.defineProperty(graph, "sqlite", { value: sqlite, writable: false });
  Object.defineProperty(graph, "workItems", { value: workItems, writable: false });

  return { db, sqlite, graphWriter, workItems, graph };
}

describe("work item state persistence", () => {
  it("round-trips every supported state through WorkItemsService.create/update", () => {
    const { db, workItems } = createServices();

    for (const [index, state] of SUPPORTED_STATES.entries()) {
      const id = `studio-${100 + index}`;
      const created = workItems.create({
        id,
        name: `Item ${state}`,
        kind: "issue",
        issue_number: 100 + index,
        state,
      });
      expect(created.state).toBe(state);

      const updated = workItems.update(id, {
        state: SUPPORTED_STATES[(index + 1) % SUPPORTED_STATES.length],
      });
      expect(updated.state).toBe(SUPPORTED_STATES[(index + 1) % SUPPORTED_STATES.length]);
    }

    db.close();
  });

  it("rejects invalid bare and dotted states through the normal write path", () => {
    const { db, workItems } = createServices();

    expect(() =>
      workItems.create({
        id: "studio-300",
        name: "Invalid state",
        kind: "issue",
        issue_number: 300,
        state: "blocked" as WorkItemState,
      }),
    ).toThrow(/CHECK constraint failed|Graph write failed|work item/i);

    const created = workItems.create({
      id: "studio-301",
      name: "Valid baseline",
      kind: "issue",
      issue_number: 301,
      state: "planned",
    });
    expect(created.state).toBe("planned");

    expect(() =>
      workItems.update("studio-301", {
        state: "pre_pr.blocked" as WorkItemState,
      }),
    ).toThrow(/CHECK constraint failed|Graph write failed|work item/i);

    db.close();
  });

  it("treats archived dependencies as satisfied in frontier queries", () => {
    const { db, graphWriter, graph } = createServices();

    const applied = graphWriter.apply({
      mutations: [
        {
          kind: "create_work_item",
          work_item: {
            id: "studio-400",
            name: "Dependency",
            kind: "issue",
            issue_number: 400,
            state: "archived",
          },
        },
        {
          kind: "create_work_item",
          work_item: {
            id: "studio-401",
            name: "Dependent",
            kind: "issue",
            issue_number: 401,
            state: "planned",
          },
        },
        {
          kind: "create_edge",
          edge: {
            from_id: "studio-401",
            rel: "depends_on",
            to_id: "studio-400",
          },
        },
      ],
    });

    expect(applied.status).toBe("applied");
    expect(graph.getFrontier().map((item) => item.id)).toContain("studio-401");

    db.close();
  });
});
