import { afterEach, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { initManifest } from "../../../lib/manifest-core.js";
import { SQLiteService } from "../../../platform/sqlite.service.js";
import { GraphWriterService } from "../graph-writer.service.js";
import { GraphController } from "../graph.controller.js";
import type { ApplyGraphMutationsDto } from "../types.js";

const databases: ReturnType<typeof initManifest>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = initManifest(":memory:"); databases.push(db);
  const sqlite = Object.create(SQLiteService.prototype);
  Object.defineProperty(sqlite, "db", { value: db });
  sqlite.initializeStudioMetadata();
  const writer = new GraphWriterService(sqlite);
  writer.apply({ mutations: [{ kind: "create_work_item", work_item: { id: "item", name: "Original", kind: "issue", state: "ready" } }] });
  return { db, sqlite, writer };
}
describe("graph request boundary", () => {
  it.each([null, {}, { mutations: null }, { mutations: [null] }, { mutations: [{ kind: "unknown" }] }, { mutations: [{ kind: "update_work_item", id: "item" }] }])("rejects malformed input without throwing: %j", (input) => {
    const { writer, sqlite } = setup();
    expect(writer.apply(input as ApplyGraphMutationsDto).status).toBe("validation_failed");
    expect(sqlite.getGraphVersion()).toBe("1");
    const controller = new GraphController({} as never, writer, {} as never);
    expect(() => controller.applyMutations(input as ApplyGraphMutationsDto)).toThrow(BadRequestException);
  });
  it.each([
    { "state = 'done', name": "Changed" }, { id: "renamed" }, { updated_at: "fake" },
    { name: 42 }, { predicted_files: "not an array" }, { meta: [] },
    JSON.parse('{"__proto__": "bad"}'),
  ])("rejects unsafe patches atomically: %j", (patch) => {
    const { db, sqlite, writer } = setup();
    const result = writer.apply({ mutations: [
      { kind: "update_work_item", id: "item", patch: { name: "Should roll back" } },
      { kind: "update_work_item", id: "item", patch },
    ] } as ApplyGraphMutationsDto);
    expect(result.status).toBe("validation_failed");
    expect(db.prepare("SELECT name, state FROM work_items WHERE id = 'item'").get()).toEqual({ name: "Original", state: "ready" });
    expect(sqlite.getGraphVersion()).toBe("1");
  });
  it("permits HSM state writes internally but rejects them on HTTP mutations", () => {
    const { writer } = setup();
    const input: ApplyGraphMutationsDto = { mutations: [{ kind: "update_work_item", id: "item", patch: { state: "done" } }] };
    const controller = new GraphController({} as never, writer, {} as never);
    expect(() => controller.applyMutations(input)).toThrow(BadRequestException);
    expect(writer.apply(input).status).toBe("applied");
  });
  it("rejects unsafe edge patches without changing the edge", () => {
    const { db, writer } = setup();
    writer.apply({ mutations: [{ kind: "create_edge", edge: { from_id: "item", to_id: "item", rel: "depends_on" } }] });
    expect(writer.apply({ mutations: [{ kind: "update_edge", id: 1, patch: { "from_id = 'missing', confidence": "certain" } }] } as unknown as ApplyGraphMutationsDto).status).toBe("validation_failed");
    expect(db.prepare("SELECT from_id FROM edges").get()).toEqual({ from_id: "item" });
  });
});
