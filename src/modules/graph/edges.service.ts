import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { GraphWriterService } from "./graph-writer.service.js";
import { SQLiteService } from "../../platform/sqlite.service.js";
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
  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
  ) {}

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
    const previousMaxId = this.getMaxEdgeId();
    const result = this.graphWriter.apply({
      mutations: [{ kind: "create_edge", edge: input }],
    });

    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

    return this.get(previousMaxId + 1);
  }

  update(id: number, input: UpdateEdgeDto): EdgeRecord {
    const result = this.graphWriter.apply({
      mutations: [{ kind: "update_edge", id, patch: input }],
    });

    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

    return this.get(id);
  }

  delete(id: number): { deleted: true; id: number } {
    const result = this.graphWriter.apply({
      mutations: [{ kind: "delete_edge", id }],
    });

    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

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

  private getMutationFailureMessage(result: { status: string; errors?: Array<{ message: string }>; message?: string }) {
    if (result.status === "validation_failed") {
      return result.errors?.[0]?.message ?? "Graph mutation validation failed";
    }
    if (result.status === "stale") {
      return result.message ?? "Graph mutation is stale";
    }
    return "Graph mutation failed";
  }

  private getMaxEdgeId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM edges").get() as { max_id: number };
    return row.max_id;
  }
}
