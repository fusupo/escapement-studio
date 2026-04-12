import { describe, it, expect, beforeEach } from "vitest";
import { initManifest } from "../../../lib/manifest-core.js";
import { GraphWriterService } from "../graph-writer.service.js";
import { SQLiteService } from "../sqlite.service.js";
import type {
  ApplyGraphMutationsDto,
  GraphMutation,
  GraphMutationsAppliedResult,
  GraphMutationsStaleResult,
  GraphMutationsValidationFailedResult,
} from "../types.js";

/**
 * Build a real SQLiteService backed by an in-memory DB.
 * We bypass NestJS DI and construct directly.
 */
function createTestSqliteService(): SQLiteService {
  // SQLiteService reads config in its field initializer, so we construct
  // a minimal stand-in that initializes an in-memory DB instead.
  const db = initManifest(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO studio_metadata (key, value) VALUES ('graph_version', '0');
  `);

  const service = Object.create(SQLiteService.prototype) as SQLiteService;
  // Inject the in-memory db via the private field
  Object.defineProperty(service, "db", { value: db, writable: false });
  (service as unknown as { initializeStudioMetadata: () => void }).initializeStudioMetadata();
  return service;
}

function createWriter(): { writer: GraphWriterService; sqlite: SQLiteService } {
  const sqlite = createTestSqliteService();
  const writer = Object.create(GraphWriterService.prototype) as GraphWriterService;
  Object.defineProperty(writer, "sqlite", { value: sqlite, writable: false });
  return { writer, sqlite };
}

function seedWorkItem(sqlite: SQLiteService, id: string, name = `Item ${id}`) {
  sqlite.getDb().prepare(
    `INSERT INTO work_items (id, name, kind, state, predicted_files, actual_files, meta)
     VALUES (?, ?, 'issue', 'planned', '[]', '[]', '{}')`
  ).run(id, name);
}

function seedEdge(sqlite: SQLiteService, fromId: string, rel: string, toId: string) {
  sqlite.getDb().prepare(
    `INSERT INTO edges (from_id, rel, to_id, confidence, meta) VALUES (?, ?, ?, 'certain', '{}')`
  ).run(fromId, rel, toId);
}

describe("GraphWriterService", () => {
  let writer: GraphWriterService;
  let sqlite: SQLiteService;

  beforeEach(() => {
    const ctx = createWriter();
    writer = ctx.writer;
    sqlite = ctx.sqlite;
  });

  describe("apply — valid batch", () => {
    it("applies create_work_item + create_edge and increments version", () => {
      const input: ApplyGraphMutationsDto = {
        mutations: [
          {
            mutation_id: "m1",
            kind: "create_work_item",
            work_item: { id: "item-a", name: "Item A", kind: "issue" },
          },
          {
            mutation_id: "m2",
            kind: "create_work_item",
            work_item: { id: "item-b", name: "Item B", kind: "issue" },
          },
          {
            mutation_id: "m3",
            kind: "create_edge",
            edge: { from_id: "item-a", rel: "depends_on", to_id: "item-b" },
          },
        ],
      };

      const result = writer.apply(input);
      expect(result.status).toBe("applied");

      const applied = result as GraphMutationsAppliedResult;
      expect(applied.applied_mutation_ids).toHaveLength(3);
      expect(applied.previous_graph_version).toBe("0");
      expect(applied.new_graph_version).toBe("1");

      // Verify data is actually in the DB
      const items = sqlite.getDb().prepare("SELECT id FROM work_items ORDER BY id").all() as { id: string }[];
      expect(items.map((r) => r.id)).toEqual(["item-a", "item-b"]);

      const edges = sqlite.getDb().prepare("SELECT from_id, rel, to_id FROM edges").all() as { from_id: string; rel: string; to_id: string }[];
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ from_id: "item-a", rel: "depends_on", to_id: "item-b" });
    });

    it("applies update_work_item on existing item", () => {
      seedWorkItem(sqlite, "item-x", "Old Name");

      const result = writer.apply({
        mutations: [
          { mutation_id: "u1", kind: "update_work_item", id: "item-x", patch: { name: "New Name", state: "in_progress" } },
        ],
      });

      expect(result.status).toBe("applied");
      const row = sqlite.getDb().prepare("SELECT name, state FROM work_items WHERE id = ?").get("item-x") as { name: string; state: string };
      expect(row.name).toBe("New Name");
      expect(row.state).toBe("in_progress");
    });

    it("accepts dotted HSM state updates", () => {
      seedWorkItem(sqlite, "item-hsm", "HSM Item");

      const result = writer.apply({
        mutations: [
          { mutation_id: "u1", kind: "update_work_item", id: "item-hsm", patch: { state: "pre_pr.in_progress" } },
        ],
      });

      expect(result.status).toBe("applied");
      const row = sqlite.getDb().prepare("SELECT state FROM work_items WHERE id = ?").get("item-hsm") as { state: string };
      expect(row.state).toBe("pre_pr.in_progress");
    });

    it("applies delete_work_item on unconnected item", () => {
      seedWorkItem(sqlite, "item-del");

      const result = writer.apply({
        mutations: [
          { mutation_id: "d1", kind: "delete_work_item", id: "item-del" },
        ],
      });

      expect(result.status).toBe("applied");
      const count = (sqlite.getDb().prepare("SELECT COUNT(*) AS c FROM work_items WHERE id = ?").get("item-del") as { c: number }).c;
      expect(count).toBe(0);
    });
  });

  describe("apply — stale rejection", () => {
    it("rejects when based_on_graph_version doesn't match current", () => {
      const result = writer.apply({
        based_on_graph_version: "999",
        mutations: [
          { mutation_id: "m1", kind: "create_work_item", work_item: { id: "x", name: "X", kind: "issue" } },
        ],
      });

      expect(result.status).toBe("stale");
      const stale = result as GraphMutationsStaleResult;
      expect(stale.current_graph_version).toBe("0");
      expect(stale.previous_graph_version).toBe("999");
    });
  });

  describe("apply — validation failures", () => {
    it("rejects empty mutations array", () => {
      const result = writer.apply({ mutations: [] });
      expect(result.status).toBe("validation_failed");

      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors).toHaveLength(1);
      expect(failed.errors[0].code).toBe("malformed_payload");
    });

    it("rejects duplicate work item ID", () => {
      seedWorkItem(sqlite, "existing");

      const result = writer.apply({
        mutations: [
          { mutation_id: "dup", kind: "create_work_item", work_item: { id: "existing", name: "Dup", kind: "issue" } },
        ],
      });

      expect(result.status).toBe("validation_failed");
      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors[0].code).toBe("duplicate_entity");
    });

    it("rejects update on non-existent item", () => {
      const result = writer.apply({
        mutations: [
          { mutation_id: "u1", kind: "update_work_item", id: "ghost", patch: { name: "Nope" } },
        ],
      });

      expect(result.status).toBe("validation_failed");
      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors[0].code).toBe("missing_entity");
    });

    it("rejects delete on item with connected edges", () => {
      seedWorkItem(sqlite, "a");
      seedWorkItem(sqlite, "b");
      seedEdge(sqlite, "a", "depends_on", "b");

      const result = writer.apply({
        mutations: [
          { mutation_id: "d1", kind: "delete_work_item", id: "a" },
        ],
      });

      expect(result.status).toBe("validation_failed");
      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors[0].code).toBe("unsafe_delete");
    });

    it("rejects create_edge when from_id does not exist", () => {
      seedWorkItem(sqlite, "real");

      const result = writer.apply({
        mutations: [
          { mutation_id: "e1", kind: "create_edge", edge: { from_id: "ghost", rel: "depends_on", to_id: "real" } },
        ],
      });

      expect(result.status).toBe("validation_failed");
      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors[0].code).toBe("missing_entity");
    });

    it("rejects duplicate edge", () => {
      seedWorkItem(sqlite, "x");
      seedWorkItem(sqlite, "y");
      seedEdge(sqlite, "x", "depends_on", "y");

      const result = writer.apply({
        mutations: [
          { mutation_id: "e1", kind: "create_edge", edge: { from_id: "x", rel: "depends_on", to_id: "y" } },
        ],
      });

      expect(result.status).toBe("validation_failed");
      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors[0].code).toBe("duplicate_edge");
    });
  });

  describe("apply — ID alignment validation", () => {
    it("rejects issue-backed work item with misaligned ID", () => {
      const result = writer.apply({
        mutations: [
          {
            mutation_id: "m1",
            kind: "create_work_item",
            work_item: { id: "studio-99", name: "Wrong ID", kind: "issue", issue_number: 42 },
          },
        ],
      });

      expect(result.status).toBe("validation_failed");
      const failed = result as GraphMutationsValidationFailedResult;
      expect(failed.errors).toHaveLength(1);
      expect(failed.errors[0].code).toBe("malformed_payload");
      expect(failed.errors[0].message).toContain('expected "studio-42"');
      expect(failed.errors[0].message).toContain('ID "studio-99" does not match issue_number 42');
    });

    it("accepts issue-backed work item with aligned ID", () => {
      const result = writer.apply({
        mutations: [
          {
            mutation_id: "m1",
            kind: "create_work_item",
            work_item: { id: "studio-42", name: "Aligned", kind: "issue", issue_number: 42 },
          },
        ],
      });

      expect(result.status).toBe("applied");
    });

    it("skips alignment check for non-issue kinds", () => {
      const result = writer.apply({
        mutations: [
          {
            mutation_id: "m1",
            kind: "create_work_item",
            work_item: { id: "phase:core", name: "Core Phase", kind: "phase" },
          },
        ],
      });

      expect(result.status).toBe("applied");
    });

    it("skips alignment check for issue items without issue_number", () => {
      const result = writer.apply({
        mutations: [
          {
            mutation_id: "m1",
            kind: "create_work_item",
            work_item: { id: "draft-item", name: "Draft", kind: "issue" },
          },
        ],
      });

      expect(result.status).toBe("applied");
    });
  });

  describe("apply — version tracking", () => {
    it("increments version on each successful apply", () => {
      writer.apply({
        mutations: [
          { kind: "create_work_item", work_item: { id: "a", name: "A", kind: "issue" } },
        ],
      });

      const result = writer.apply({
        based_on_graph_version: "1",
        mutations: [
          { kind: "create_work_item", work_item: { id: "b", name: "B", kind: "issue" } },
        ],
      });

      expect(result.status).toBe("applied");
      expect((result as GraphMutationsAppliedResult).new_graph_version).toBe("2");
    });
  });
});
