import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../src/config.js";
import { archiveBundleExists } from "../src/lib/context-layout.js";

export interface DoneToArchivedMigrationResult {
  promoted: string[];
  untouched: string[];
  warnings: string[];
}

export interface DoneToArchivedMigrationOptions {
  manifestPath?: string;
  artifactRoot?: string;
  log?: (message: string) => void;
}

export function detectManifestConcurrencyWarnings(manifestPath: string): string[] {
  const warnings: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    const file = `${manifestPath}${suffix}`;
    if (existsSync(file)) {
      warnings.push(`Warning: detected live SQLite sidecar ${file}; run only when no Nest server process is active.`);
    }
  }
  return warnings;
}

export function migrateDoneToArchived(
  options: DoneToArchivedMigrationOptions = {},
): DoneToArchivedMigrationResult {
  const manifestPath = resolve(options.manifestPath ?? getConfig().manifestPath);
  const artifactRoot = resolve(options.artifactRoot ?? getConfig().artifactRoot);
  const log = options.log ?? (() => {});
  const warnings = detectManifestConcurrencyWarnings(manifestPath);
  for (const warning of warnings) {
    log(warning);
  }

  const db = new Database(manifestPath);
  try {
    const rows = db
      .prepare("SELECT id FROM work_items WHERE state = 'done' ORDER BY id")
      .all() as Array<{ id: string }>;

    const promote = db.prepare("UPDATE work_items SET state = 'archived' WHERE id = ? AND state = 'done'");
    const promoted: string[] = [];
    const untouched: string[] = [];

    for (const row of rows) {
      if (archiveBundleExists(artifactRoot, row.id)) {
        promote.run(row.id);
        promoted.push(row.id);
        log(`Promoted ${row.id}: done -> archived`);
      } else {
        untouched.push(row.id);
        log(`Left ${row.id} as done: archive bundle missing`);
      }
    }

    return { promoted, untouched, warnings };
  } finally {
    db.close();
  }
}

export function main(): DoneToArchivedMigrationResult {
  const result = migrateDoneToArchived({ log: (message) => console.log(message) });
  console.log(`Promotion summary: promoted=${result.promoted.length} untouched=${result.untouched.length}`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
