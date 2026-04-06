import { Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { getConfig } from "../../config.js";
import { hasSchema, initManifest, isHealthy } from "../../lib/manifest-core.js";

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

    // Extend upstream CHECK constraint to include open_pr state
    this.migrateWorkItemStates();
  }

  private migrateWorkItemStates() {
    // Check if open_pr is already allowed
    const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get() as { sql: string } | undefined;
    if (!tableInfo?.sql || tableInfo.sql.includes("open_pr")) {
      return; // already migrated or no table
    }

    // SQLite doesn't support ALTER CHECK — recreate with new constraint
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items_new (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'issue'
                    CHECK (kind IN ('issue','capability','phase','track')),
        state       TEXT NOT NULL DEFAULT 'planned'
                    CHECK (state IN (
                      'planned',
                      'in_progress',
                      'open_pr',
                      'done',
                      'deferred',
                      'cancelled'
                    )),
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

      INSERT OR IGNORE INTO work_items_new SELECT * FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_new RENAME TO work_items;
    `);
  }
}
