import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { parseJsonArray } from "../../lib/manifest-core.js";
import { GraphWriterService } from "./graph-writer.service.js";
import { SQLiteService } from "../../platform/sqlite.service.js";
import { deriveIssueWorkItemId, type CreateWorkItemDto, type EdgeRecord, type MisalignedWorkItem, type UpdateWorkItemDto, type WorkItemRecord, type WorkItemState } from "./types.js";

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
  private readonly logger = new Logger(WorkItemsService.name);

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

  listByRepoIssueNumber(repo: string, issueNumber: number): WorkItemRecord[] {
    if (!repo?.trim() || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      return [];
    }

    return this.list({ repo }).filter((item) => item.issue_number === issueNumber);
  }

  listByRepoBranch(repo: string, branch: string): WorkItemRecord[] {
    const normalizedRepo = repo?.trim();
    const normalizedBranch = branch?.trim();
    if (!normalizedRepo || !normalizedBranch) {
      return [];
    }

    return this.list({ repo: normalizedRepo }).filter((item) => item.branch?.trim() === normalizedBranch);
  }

  listByRepoPullRequestNumber(repo: string, pullRequestNumber: number): WorkItemRecord[] {
    if (!repo?.trim() || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
      return [];
    }

    return this.list({ repo }).filter((item) => this.extractPullRequestNumbers(item.meta).includes(pullRequestNumber));
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

  /**
   * Logged escape hatch for setting work item state directly, bypassing
   * the HSM. Intended for migration tooling and exceptional recovery
   * scenarios. All calls are logged with the provided reason.
   *
   * Production code should use `WorkItemHsmService.dispatch()` instead.
   */
  unsafeSetState(id: string, state: WorkItemState, reason: string): WorkItemRecord {
    this.logger.warn(`unsafeSetState: ${id} → ${state} (reason: ${reason})`);
    return this.update(id, { state });
  }

  getConnectedEdges(id: string): EdgeRecord[] {
    if (!id?.trim()) {
      return [];
    }

    const rows = this.db
      .prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY id")
      .all(id, id) as Array<{
        id: number;
        from_id: string;
        rel: EdgeRecord["rel"];
        to_id: string;
        confidence: EdgeRecord["confidence"];
        meta: string;
        created_at: string;
      }>;

    return rows.map((row) => ({
      ...row,
      meta: this.parseMeta(row.meta),
    }));
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

  deleteWithConnectedEdges(id: string, edgeIds: number[]): { deleted: true; id: string; removed_edge_ids: number[] } {
    const connectedEdges = this.getConnectedEdges(id);
    const connectedEdgeIds = new Set(connectedEdges.map((edge) => edge.id));
    const requestedEdgeIds = [...new Set(edgeIds.filter((edgeId) => Number.isInteger(edgeId)))];

    if (requestedEdgeIds.length !== connectedEdges.length || requestedEdgeIds.some((edgeId) => !connectedEdgeIds.has(edgeId))) {
      throw new BadRequestException(`delete_work_item_requires_all_connected_edges: ${id}`);
    }

    const result = this.graphWriter.deleteWorkItemWithEdges(id, requestedEdgeIds);
    if (result.status !== "applied") {
      throw new BadRequestException(this.getMutationFailureMessage(result));
    }

    return { deleted: true, id, removed_edge_ids: requestedEdgeIds.sort((a, b) => a - b) };
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

  private extractPullRequestNumbers(meta: Record<string, unknown>): number[] {
    const values = [
      this.readPullRequestNumber(meta.pull_request),
      this.readPullRequestNumber(this.readNested(meta, ["studio_post_merge_sync", "pull_request"])),
    ];

    return values.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
  }

  private readPullRequestNumber(value: unknown): number | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const number = (value as Record<string, unknown>).number;
    return Number.isInteger(number) && Number(number) > 0 ? Number(number) : null;
  }

  private readNested(value: unknown, path: string[]): unknown {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== "object") {
        return null;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
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
