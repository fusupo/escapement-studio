import { Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { getConfig } from "../config.js";
import { hasSchema, initManifest, isHealthy } from "../lib/manifest-core.js";

/**
 * Phase 6a (#235): moved from `src/modules/graph/sqlite.service.ts`
 * to `src/platform/sqlite.service.ts`. `SQLiteService` is
 * infrastructure — a 135-line wrapper around `better-sqlite3` +
 * startup schema migration — not a graph concern. Placing it in the
 * `@Global()` PlatformModule removes the last transitive dependency
 * that required `Settings → Graph`, `Execution → Settings`, and
 * `Plans → Settings` forwardRefs. See `docs/proposals/phase-6-platform-module.md`.
 */
@Injectable()
export class SQLiteService {
  private readonly manifestPath = getConfig().manifestPath;
  private readonly db: DatabaseType = initManifest(this.manifestPath);

  constructor() {
    this.initializeStudioMetadata();
  }

  getDb(): DatabaseType {
    return this.db;
  }

  getPath(): string {
    return this.manifestPath;
  }

  isHealthy(): boolean {
    return isHealthy(this.db);
  }

  hasSchema(): boolean {
    return hasSchema(this.db);
  }

  getGraphVersion(): string {
    const row = this.db
      .prepare("SELECT value FROM studio_metadata WHERE key = 'graph_version'")
      .get() as { value: string } | undefined;
    return row?.value ?? "0";
  }

  incrementGraphVersion(): string {
    const next = String(Number(this.getGraphVersion()) + 1);
    this.db
      .prepare(
        `INSERT INTO studio_metadata (key, value) VALUES ('graph_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(next);
    return next;
  }

  private initializeStudioMetadata() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS studio_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.db
      .prepare("INSERT OR IGNORE INTO studio_metadata (key, value) VALUES ('graph_version', '0')")
      .run();

    // Extend upstream CHECK constraint to include the HSM-aligned state set.
    this.migrateWorkItemStates();
  }

  private migrateWorkItemStates() {
    const migrationKey = "schema:work_item_states:v1";
    if (this.db.prepare("SELECT 1 FROM studio_metadata WHERE key = ?").get(migrationKey)) return;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'").get()) return;
    const schemaObjects = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = 'work_items' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
    ).all() as Array<{ sql: string }>;
    const foreignKeys = this.db.pragma("foreign_keys", { simple: true });
    // FK mode must change outside the transaction. Every DDL/data write and
    // the version marker commit together, or the original table is restored.
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`
      CREATE TABLE work_items_new (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'issue'
                    CHECK (kind IN ('issue','capability','phase','track')),
        state       TEXT NOT NULL DEFAULT 'planned'
                    CHECK (
                      state IN (
                        'planned',
                        'drafting',
                        'ready',
                        'in_progress',
                        'run_errored',
                        'open_pr',
                        'merged_pr',
                        'closed',
                        'deferred',
                        'done',
                        'archived',
                        'cancelled'
                      )
                      OR (
                        instr(state, '.') > 1
                        AND instr(substr(state, instr(state, '.') + 1), '.') = 0
                        AND substr(state, instr(state, '.') + 1) IN (
                          'planned',
                          'drafting',
                          'ready',
                          'in_progress',
                          'run_errored',
                          'open_pr',
                          'merged_pr',
                          'closed',
                          'deferred',
                          'done',
                          'archived',
                          'cancelled'
                        )
                      )
                    ),
        repo            TEXT,
        issue_number    INTEGER,
        issue_url       TEXT,
        scope_hint      TEXT,
        branch          TEXT,
        archive_path    TEXT,
        predicted_files TEXT DEFAULT '[]',
        actual_files    TEXT DEFAULT '[]',
        meta            TEXT DEFAULT '{}',
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      INSERT INTO work_items_new SELECT * FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_new RENAME TO work_items;
        `);
        for (const { sql } of schemaObjects) this.db.exec(sql);
        if ((this.db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Work item migration violates foreign keys");
        this.db.prepare("INSERT INTO studio_metadata (key, value) VALUES (?, '1')").run(migrationKey);
      })();
    } finally {
      this.db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
  }
}
