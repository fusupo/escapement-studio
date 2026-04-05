import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { SQLiteService } from "./sqlite.service.js";
import type { CreateEdgeDto, EdgeRecord, UpdateEdgeDto } from "./types.js";

interface RawEdgeRecord {
  id: number;
  from_id: string;
  rel: EdgeRecord["rel"];
  to_id: string;
  confidence: EdgeRecord["confidence"];
  meta: string;
  created_at: string;
}

@Injectable()
export class EdgesService {
  constructor(@Inject(SQLiteService) private readonly sqlite: SQLiteService) {}

  private get db(): DatabaseType {
    return this.sqlite.getDb();
  }

  list(filters: { from_id?: string; to_id?: string; rel?: string } = {}): EdgeRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.from_id) {
      clauses.push("from_id = ?");
      params.push(filters.from_id);
    }
    if (filters.to_id) {
      clauses.push("to_id = ?");
      params.push(filters.to_id);
    }
    if (filters.rel) {
      clauses.push("rel = ?");
      params.push(filters.rel);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM edges ${where} ORDER BY id`).all(...params) as RawEdgeRecord[];
    return rows.map((row) => this.toRecord(row));
  }

  get(id: number): EdgeRecord {
    const row = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as RawEdgeRecord | undefined;
    if (!row) {
      throw new NotFoundException(`Edge not found: ${id}`);
    }
    return this.toRecord(row);
  }

  create(input: CreateEdgeDto): EdgeRecord {
    let id: number;
    try {
      const result = this.db
        .prepare(`INSERT INTO edges (from_id, rel, to_id, confidence, meta) VALUES (?, ?, ?, ?, ?)`)
        .run(
          input.from_id,
          input.rel,
          input.to_id,
          input.confidence ?? "certain",
          JSON.stringify(input.meta ?? {}),
        );
      id = Number(result.lastInsertRowid);
    } catch (error) {
      throw new BadRequestException(this.getErrorMessage(error));
    }
    return this.get(id);
  }

  update(id: number, input: UpdateEdgeDto): EdgeRecord {
    this.get(id);

    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(input)) {
      assignments.push(`${key} = ?`);
      params.push(key === "meta" ? JSON.stringify(value ?? {}) : value ?? null);
    }

    if (assignments.length === 0) {
      return this.get(id);
    }

    try {
      this.db.prepare(`UPDATE edges SET ${assignments.join(", ")} WHERE id = ?`).run(...params, id);
    } catch (error) {
      throw new BadRequestException(this.getErrorMessage(error));
    }

    return this.get(id);
  }

  delete(id: number): { deleted: true; id: number } {
    this.get(id);
    this.db.prepare("DELETE FROM edges WHERE id = ?").run(id);
    return { deleted: true, id };
  }

  private toRecord(row: RawEdgeRecord): EdgeRecord {
    return {
      ...row,
      meta: this.parseMeta(row.meta),
    };
  }

  private parseMeta(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown SQLite error";
  }
}
