import { describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { initManifest } from "../lib/manifest-core.js";
import { SQLiteService } from "../modules/graph/sqlite.service.js";
import { VALID_HUMAN_TRANSITIONS } from "../modules/graph/state-transitions.js";
import type { WorkItemState } from "../modules/graph/types.js";

/**
 * ADR 014 step 3 state-machine allowlist.
 *
 * This test enforces a single source of truth: the 12 canonical
 * WorkItemState values. It asserts:
 *  1. All 12 states are accepted by the SQLite CHECK constraint
 *  2. An invalid state is rejected by the constraint
 *  3. VALID_HUMAN_TRANSITIONS has an entry for every state (no
 *     accidentally-missing rows)
 *
 * If any future code adds a new state, this test will flag missing
 * DB coverage and/or missing transition allowlist entries at test time.
 */

const ALL_STATES: WorkItemState[] = [
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

/**
 * Build an in-memory DB with the Studio-expanded CHECK constraint in place.
 *
 * Uses the Object.create harness pattern established in
 * graph-writer.service.test.ts to bypass the SQLiteService constructor's
 * reliance on getConfig(). The private `migrateWorkItemStates` method is
 * invoked via the prototype so we exercise real production migration SQL
 * — if the migration breaks, this test breaks.
 */
function createMigratedDb(): DatabaseType {
  const db = initManifest(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO studio_metadata (key, value) VALUES ('graph_version', '0');
  `);

  const service = Object.create(SQLiteService.prototype) as SQLiteService;
  Object.defineProperty(service, "db", { value: db, writable: false });
  // Invoke the private migration via prototype — we're intentionally
  // exercising the real production migration SQL in this test.
  (SQLiteService.prototype as unknown as { migrateWorkItemStates: () => void })
    .migrateWorkItemStates.call(service);

  return db;
}

function insertWorkItemWithState(db: DatabaseType, id: string, state: string): void {
  db.prepare(
    `INSERT INTO work_items (id, name, kind, state, predicted_files, actual_files, meta)
     VALUES (?, ?, 'issue', ?, '[]', '[]', '{}')`,
  ).run(id, `Item ${id}`, state);
}

describe("state-machine allowlist", () => {
  describe("SQLite CHECK constraint", () => {
    it("accepts every canonical WorkItemState value", () => {
      const db = createMigratedDb();
      for (const state of ALL_STATES) {
        expect(() => insertWorkItemWithState(db, `item-${state}`, state)).not.toThrow();
      }
      db.close();
    });

    it("accepts dotted compatibility forms that end in a canonical leaf state", () => {
      const db = createMigratedDb();
      expect(() => insertWorkItemWithState(db, "item-dotted", "pre_pr.in_progress")).not.toThrow();
      expect(() => insertWorkItemWithState(db, "item-dotted-archived", "post_pr.archived")).not.toThrow();
      db.close();
    });

    it("rejects a state that is not in the canonical set", () => {
      const db = createMigratedDb();
      expect(() => insertWorkItemWithState(db, "item-bad", "totally_made_up")).toThrow();
      db.close();
    });

    it("still rejects the legacy state value that was removed in earlier migrations", () => {
      const db = createMigratedDb();
      // "blocked" was never a canonical state — it is a derived view per ADR 014
      expect(() => insertWorkItemWithState(db, "item-blocked", "blocked")).toThrow();
      db.close();
    });

    it("rejects dotted compatibility forms whose leaf state is unknown", () => {
      const db = createMigratedDb();
      expect(() => insertWorkItemWithState(db, "item-bad-dotted", "pre_pr.blocked")).toThrow();
      db.close();
    });
  });

  describe("VALID_HUMAN_TRANSITIONS", () => {
    it("has an entry for every canonical state", () => {
      for (const state of ALL_STATES) {
        expect(VALID_HUMAN_TRANSITIONS).toHaveProperty(state);
      }
    });

    it("every transition target is itself a canonical state", () => {
      const stateSet = new Set<string>(ALL_STATES);
      for (const [from, targets] of Object.entries(VALID_HUMAN_TRANSITIONS)) {
        for (const to of targets) {
          expect(stateSet.has(to)).toBe(true);
          // Self-transitions are not meaningful
          expect(to).not.toBe(from);
        }
      }
    });

    it("terminal and placeholder states have no human-triggered outbound transitions", () => {
      expect(VALID_HUMAN_TRANSITIONS.run_errored).toEqual([]);
      expect(VALID_HUMAN_TRANSITIONS.closed).toEqual([]);
      expect(VALID_HUMAN_TRANSITIONS.done).toEqual([]);
      expect(VALID_HUMAN_TRANSITIONS.archived).toEqual([]);
      expect(VALID_HUMAN_TRANSITIONS.cancelled).toEqual([]);
      // merged_pr → done is triggered by the disposition endpoints
      // (POST /api/execution/close-merged, POST /api/execution/archive-and-close-merged)
      // not by a human reviewer via the generic transition endpoint, so the
      // allowlist stays empty here.
      expect(VALID_HUMAN_TRANSITIONS.merged_pr).toEqual([]);
    });
  });
});
