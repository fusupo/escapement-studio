import { Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { getConfig } from "../../config.js";
import { hasSchema, initManifest, isHealthy } from "../../lib/manifest-core.js";

@Injectable()
export class SQLiteService {
  private readonly manifestPath = getConfig().manifestPath;
  private readonly db: DatabaseType = initManifest(this.manifestPath);

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
}
