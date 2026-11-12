import { afterEach, describe, expect, it } from "vitest";
import { initManifest } from "../../lib/manifest-core.js";
import { SQLiteService } from "../sqlite.service.js";
const databases: ReturnType<typeof initManifest>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = initManifest(":memory:"); databases.push(db);
  const service = Object.create(SQLiteService.prototype);
  Object.defineProperty(service, "db", { value: db });
  db.exec("INSERT INTO work_items (id, name, kind) VALUES ('one', 'One', 'issue'), ('two', 'Two', 'issue'); INSERT INTO edges (from_id, to_id, rel) VALUES ('one', 'two', 'depends_on');");
  return { db, migrate: () => service.initializeStudioMetadata() };
}
describe("work item schema migration", () => {
  it("preserves data, foreign keys, indexes and triggers and does not rebuild on restart", () => {
    const { db, migrate } = setup();
    db.exec("CREATE INDEX custom_work_item_name ON work_items(name); CREATE TABLE audit (name TEXT); CREATE TRIGGER audit_name AFTER UPDATE OF name ON work_items BEGIN INSERT INTO audit VALUES (new.name); END;");
    migrate();
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges").get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'custom_work_item_name'").get()).toBeDefined();
    db.exec("UPDATE work_items SET name = 'changed' WHERE id = 'one'");
    expect(db.prepare("SELECT * FROM audit").all()).toEqual([{ name: "changed" }]);
    const schemaVersion = db.pragma("schema_version", { simple: true });
    migrate();
    expect(db.pragma("schema_version", { simple: true })).toBe(schemaVersion);
  });
  it("rolls back a rejected copy and restores FK enforcement without marking success", () => {
    const { db, migrate } = setup();
    db.pragma("ignore_check_constraints = ON");
    db.exec("UPDATE work_items SET state = 'invalid_state' WHERE id = 'one'");
    db.pragma("ignore_check_constraints = OFF");
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'work_items'").get();
    expect(migrate).toThrow();
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'work_items'").get()).toEqual(original);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT 1 FROM studio_metadata WHERE key = 'schema:work_item_states:v1'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'work_items_new'").get()).toBeUndefined();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.exec("UPDATE work_items SET state = 'planned' WHERE id = 'one'");
    expect(migrate).not.toThrow();
  });
});
