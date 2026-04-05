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
  }
}
