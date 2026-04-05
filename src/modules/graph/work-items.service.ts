import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { parseJsonArray } from "../../lib/manifest-core.js";
import { SQLiteService } from "./sqlite.service.js";
import type { CreateWorkItemDto, UpdateWorkItemDto, WorkItemRecord } from "./types.js";

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
  constructor(@Inject(SQLiteService) private readonly sqlite: SQLiteService) {}

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
    try {
      this.db
        .prepare(
          `INSERT INTO work_items (
            id, name, kind, state, repo, issue_number, issue_url, scope_hint,
            branch, archive_path, predicted_files, actual_files, meta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.name,
          input.kind,
          input.state ?? "planned",
          input.repo ?? null,
          input.issue_number ?? null,
          input.issue_url ?? null,
          input.scope_hint ?? null,
          input.branch ?? null,
          input.archive_path ?? null,
          JSON.stringify(input.predicted_files ?? []),
          JSON.stringify(input.actual_files ?? []),
          JSON.stringify(input.meta ?? {}),
        );
    } catch (error) {
      throw new BadRequestException(this.getErrorMessage(error));
    }

    return this.get(input.id);
  }

  update(id: string, input: UpdateWorkItemDto): WorkItemRecord {
    this.get(id);

    const assignments: string[] = [];
    const params: unknown[] = [];
    const entries = Object.entries(input) as [keyof UpdateWorkItemDto, unknown][];

    for (const [key, value] of entries) {
      assignments.push(`${key} = ?`);
      if (key === "predicted_files" || key === "actual_files" || key === "meta") {
        params.push(JSON.stringify(value ?? (key === "meta" ? {} : [])));
      } else {
        params.push(value ?? null);
      }
    }

    if (assignments.length === 0) {
      return this.get(id);
    }

    assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");

    try {
      this.db
        .prepare(`UPDATE work_items SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...params, id);
    } catch (error) {
      throw new BadRequestException(this.getErrorMessage(error));
    }

    return this.get(id);
  }

  delete(id: string): { deleted: true; id: string } {
    this.get(id);

    try {
      this.db.prepare("DELETE FROM work_items WHERE id = ?").run(id);
    } catch (error) {
      throw new BadRequestException(this.getErrorMessage(error));
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
}
