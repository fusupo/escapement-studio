import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { parseJsonArray } from "../../lib/manifest-core.js";
import { GraphWriterService } from "./graph-writer.service.js";
import { SQLiteService } from "./sqlite.service.js";
import { deriveIssueWorkItemId, type CreateWorkItemDto, type MisalignedWorkItem, type UpdateWorkItemDto, type WorkItemRecord } from "./types.js";

interface RawWorkItemRecord {
  id: string;
  name: string;
  kind: WorkItemRecord["kind"];
  state: WorkItemRecord["state"];
  repo: string | null;
  issue_number: number | null;
  issue_url: string | null;
  scope_hint: string | null;
  branch: string | null;
  archive_path: string | null;
  predicted_files: string;
  actual_files: string;
  meta: string;
  updated_at: string;
}

@Injectable()
export class WorkItemsService {
  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
  ) {}

  private get db(): DatabaseType {
    return this.sqlite.getDb();
  }

  list(filters: { repo?: string; state?: string; kind?: string } = {}): WorkItemRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.repo) {
      clauses.push("repo = ?");
      params.push(filters.repo);
    }
    if (filters.state) {
      clauses.push("state = ?");
      params.push(filters.state);
    }
    if (filters.kind) {
      clauses.push("kind = ?");
      params.push(filters.kind);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM work_items ${where} ORDER BY id`)
      .all(...params) as RawWorkItemRecord[];

    return rows.map((row) => this.toRecord(row));
  }

  get(id: string): WorkItemRecord {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
      | RawWorkItemRecord
      | undefined;

    if (!row) {
      throw new NotFoundException(`Work item not found: ${id}`);
    }

    return this.toRecord(row);
  }

  create(input: CreateWorkItemDto): WorkItemRecord {
    const result = this.graphWriter.apply({
      mutations: [{ kind: "create_work_item", work_item: input }],
    });

    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

    return this.get(input.id);
  }

  update(id: string, input: UpdateWorkItemDto): WorkItemRecord {
    const result = this.graphWriter.apply({
      mutations: [{ kind: "update_work_item", id, patch: input }],
    });

    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

    return this.get(id);
  }

  /**
   * Find issue-backed work items whose ID does not match their issue_number.
   */
  findMisaligned(): MisalignedWorkItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, issue_number FROM work_items
         WHERE kind = 'issue' AND issue_number IS NOT NULL`
      )
      .all() as Array<{ id: string; issue_number: number }>;

    const misaligned: MisalignedWorkItem[] = [];
    for (const row of rows) {
      const expected = deriveIssueWorkItemId(row.issue_number);
      if (row.id !== expected) {
        misaligned.push({ id: row.id, issue_number: row.issue_number, expected_id: expected });
      }
    }
    return misaligned;
  }

  delete(id: string): { deleted: true; id: string } {
    const result = this.graphWriter.apply({
      mutations: [{ kind: "delete_work_item", id }],
    });

    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

    return { deleted: true, id };
  }

  private toRecord(row: RawWorkItemRecord): WorkItemRecord {
    return {
      ...row,
      predicted_files: parseJsonArray(row.predicted_files),
      actual_files: parseJsonArray(row.actual_files),
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
}
