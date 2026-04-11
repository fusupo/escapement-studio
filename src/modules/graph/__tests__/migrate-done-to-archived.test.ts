import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initManifest } from "../../../lib/manifest-core.js";
import { archiveDir } from "../../../lib/context-layout.js";
import { SQLiteService } from "../sqlite.service.js";
import { migrateDoneToArchived } from "../../../../scripts/migrate-done-to-archived.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "studio-193-"));
  tempRoots.push(root);
  return root;
}

function createMigratedDb(manifestPath: string) {
  const db = initManifest(manifestPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO studio_metadata (key, value) VALUES ('graph_version', '0');
  `);

  const service = Object.create(SQLiteService.prototype) as SQLiteService;
  Object.defineProperty(service, "db", { value: db, writable: false });
  (SQLiteService.prototype as unknown as { migrateWorkItemStates: () => void }).migrateWorkItemStates.call(service);
  return db;
}

function seedWorkItem(db: ReturnType<typeof createMigratedDb>, id: string, state: string) {
  db.prepare(
    `INSERT INTO work_items (id, name, kind, state, predicted_files, actual_files, meta)
     VALUES (?, ?, 'issue', ?, '[]', '[]', '{}')`,
  ).run(id, id, state);
}

describe("migrateDoneToArchived", () => {
  it("promotes done items with archive bundles and leaves others untouched", () => {
    const root = makeTempRoot();
    const artifactRoot = join(root, "artifacts");
    const manifestPath = join(root, "manifest.db");
    const db = createMigratedDb(manifestPath);

    seedWorkItem(db, "studio-193", "done");
    seedWorkItem(db, "studio-194", "done");
    seedWorkItem(db, "studio-195", "archived");
    mkdirSync(archiveDir(artifactRoot, "studio-193"), { recursive: true });

    const first = migrateDoneToArchived({ manifestPath, artifactRoot });
    expect(first.promoted).toEqual(["studio-193"]);
    expect(first.untouched).toEqual(["studio-194"]);

    const states = db.prepare("SELECT id, state FROM work_items ORDER BY id").all() as Array<{ id: string; state: string }>;
    expect(states).toEqual([
      { id: "studio-193", state: "archived" },
      { id: "studio-194", state: "done" },
      { id: "studio-195", state: "archived" },
    ]);

    const second = migrateDoneToArchived({ manifestPath, artifactRoot });
    expect(second.promoted).toEqual([]);
    expect(second.untouched).toEqual(["studio-194"]);

    db.close();
  });

  it("warns on WAL/SHM sidecars without aborting", () => {
    const root = makeTempRoot();
    const artifactRoot = join(root, "artifacts");
    const manifestPath = join(root, "manifest.db");
    const db = createMigratedDb(manifestPath);
    seedWorkItem(db, "studio-196", "done");
    mkdirSync(archiveDir(artifactRoot, "studio-196"), { recursive: true });
    writeFileSync(`${manifestPath}-wal`, "wal", "utf8");
    writeFileSync(`${manifestPath}-shm`, "shm", "utf8");

    const logs: string[] = [];
    const result = migrateDoneToArchived({
      manifestPath,
      artifactRoot,
      log: (message) => logs.push(message),
    });

    expect(result.promoted).toEqual(["studio-196"]);
    expect(result.warnings).toHaveLength(2);
    expect(logs.some((line) => line.includes("-wal"))).toBe(true);
    expect(logs.some((line) => line.includes("-shm"))).toBe(true);

    db.close();
  });
});
