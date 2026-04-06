import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { SQLiteService } from "./sqlite.service.js";
import {
  checkIdAlignment,
  type ApplyGraphMutationsDto,
  type ApplyGraphMutationsResult,
  type CreateEdgeDto,
  type CreateWorkItemDto,
  type EdgeConfidence,
  type EdgeRel,
  type GraphMutation,
  type GraphMutationError,
  type UpdateEdgeDto,
  type UpdateWorkItemDto,
  type WorkItemKind,
  type WorkItemState,
} from "./types.js";

interface RawWorkItemRecord {
  id: string;
  name: string;
  kind: WorkItemKind;
  state: WorkItemState;
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

interface RawEdgeRecord {
  id: number;
  from_id: string;
  rel: EdgeRel;
  to_id: string;
  confidence: EdgeConfidence;
  meta: string;
  created_at: string;
}

interface GraphStateSnapshot {
  workItems: Map<string, RawWorkItemRecord>;
  edges: Map<number, RawEdgeRecord>;
  nextEdgeId: number;
}

@Injectable()
export class GraphWriterService {
  constructor(@Inject(SQLiteService) private readonly sqlite: SQLiteService) {}

  private get db(): DatabaseType {
    return this.sqlite.getDb();
  }

  apply(input: ApplyGraphMutationsDto): ApplyGraphMutationsResult {
    const currentGraphVersion = this.sqlite.getGraphVersion();
    const proposalId = input.proposal_id ?? null;

    if (!Array.isArray(input.mutations) || input.mutations.length === 0) {
      return {
        status: "validation_failed",
        proposal_id: proposalId,
        current_graph_version: currentGraphVersion,
        errors: [
          {
            mutation_id: null,
            code: "malformed_payload",
            message: "mutations must contain at least one mutation",
          },
        ],
      };
    }

    if (input.based_on_graph_version && input.based_on_graph_version !== currentGraphVersion) {
      return {
        status: "stale",
        proposal_id: proposalId,
        previous_graph_version: input.based_on_graph_version,
        current_graph_version: currentGraphVersion,
        message: "Proposal is out of date and must be regenerated.",
      };
    }

    const normalizedMutations = [...input.mutations].sort((left, right) => {
      const order = this.getMutationOrder(left.kind) - this.getMutationOrder(right.kind);
      return order !== 0 ? order : this.getMutationId(left).localeCompare(this.getMutationId(right));
    });

    const snapshot = this.loadSnapshot();
    const errors = this.validateMutations(normalizedMutations, snapshot);
    if (errors.length > 0) {
      return {
        status: "validation_failed",
        proposal_id: proposalId,
        current_graph_version: currentGraphVersion,
        errors,
      };
    }

    const transaction = this.db.transaction((mutations: GraphMutation[]) => {
      for (const mutation of mutations) {
        this.applyMutation(mutation);
      }
      return this.sqlite.incrementGraphVersion();
    });

    try {
      const newGraphVersion = transaction(normalizedMutations);
      return {
        status: "applied",
        proposal_id: proposalId,
        applied_mutation_ids: normalizedMutations.map((mutation) => this.getMutationId(mutation)),
        previous_graph_version: currentGraphVersion,
        new_graph_version: newGraphVersion,
      };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Graph write failed");
    }
  }

  private validateMutations(mutations: GraphMutation[], snapshot: GraphStateSnapshot): GraphMutationError[] {
    const errors: GraphMutationError[] = [];

    for (const mutation of mutations) {
      switch (mutation.kind) {
        case "create_work_item": {
          const { work_item } = mutation;
          if (!work_item?.id || !work_item?.name || !work_item?.kind) {
            errors.push(this.error(mutation, "malformed_payload", "create_work_item requires id, name, and kind"));
            continue;
          }
          if (snapshot.workItems.has(work_item.id)) {
            errors.push(this.error(mutation, "duplicate_entity", `work item already exists: ${work_item.id}`));
            continue;
          }
          const alignmentIssue = checkIdAlignment(work_item.id, work_item.kind, work_item.issue_number);
          if (alignmentIssue) {
            errors.push(this.error(mutation, "malformed_payload", alignmentIssue));
            continue;
          }
          snapshot.workItems.set(work_item.id, this.toRawWorkItem(work_item));
          continue;
        }

        case "update_work_item": {
          const { id, patch } = mutation;
          if (!id || !patch || typeof patch !== "object") {
            errors.push(this.error(mutation, "malformed_payload", "update_work_item requires id and patch"));
            continue;
          }
          const existing = snapshot.workItems.get(id);
          if (!existing) {
            errors.push(this.error(mutation, "missing_entity", `work item does not exist: ${id}`));
            continue;
          }
          snapshot.workItems.set(id, {
            ...existing,
            ...this.toRawWorkItemPatch(patch),
            updated_at: this.now(),
          });
          continue;
        }

        case "delete_work_item": {
          const { id } = mutation;
          if (!id) {
            errors.push(this.error(mutation, "malformed_payload", "delete_work_item requires id"));
            continue;
          }
          if (!snapshot.workItems.has(id)) {
            errors.push(this.error(mutation, "missing_entity", `work item does not exist: ${id}`));
            continue;
          }
          const connected = Array.from(snapshot.edges.values()).some((edge) => edge.from_id === id || edge.to_id === id);
          if (connected) {
            errors.push(this.error(mutation, "unsafe_delete", `work item has connected edges: ${id}`));
            continue;
          }
          snapshot.workItems.delete(id);
          continue;
        }

        case "create_edge": {
          const { edge } = mutation;
          if (!edge?.from_id || !edge?.to_id || !edge?.rel) {
            errors.push(this.error(mutation, "malformed_payload", "create_edge requires from_id, to_id, and rel"));
            continue;
          }
          if (!snapshot.workItems.has(edge.from_id)) {
            errors.push(this.error(mutation, "missing_entity", `from_id does not exist: ${edge.from_id}`));
            continue;
          }
          if (!snapshot.workItems.has(edge.to_id)) {
            errors.push(this.error(mutation, "missing_entity", `to_id does not exist: ${edge.to_id}`));
            continue;
          }
          if (this.hasEdge(snapshot.edges, edge.from_id, edge.rel, edge.to_id)) {
            errors.push(this.error(mutation, "duplicate_edge", `edge already exists: ${edge.from_id} ${edge.rel} ${edge.to_id}`));
            continue;
          }
          const id = snapshot.nextEdgeId++;
          snapshot.edges.set(id, this.toRawEdge(id, edge));
          continue;
        }

        case "update_edge": {
          const { id, patch } = mutation;
          if (typeof id !== "number" || !patch || typeof patch !== "object") {
            errors.push(this.error(mutation, "malformed_payload", "update_edge requires id and patch"));
            continue;
          }
          const existing = snapshot.edges.get(id);
          if (!existing) {
            errors.push(this.error(mutation, "missing_entity", `edge does not exist: ${id}`));
            continue;
          }
          const next = {
            ...existing,
            ...this.toRawEdgePatch(patch),
          } satisfies RawEdgeRecord;
          if (!snapshot.workItems.has(next.from_id)) {
            errors.push(this.error(mutation, "missing_entity", `from_id does not exist: ${next.from_id}`));
            continue;
          }
          if (!snapshot.workItems.has(next.to_id)) {
            errors.push(this.error(mutation, "missing_entity", `to_id does not exist: ${next.to_id}`));
            continue;
          }
          if (
            Array.from(snapshot.edges.values()).some(
              (edge) => edge.id !== id && edge.from_id === next.from_id && edge.rel === next.rel && edge.to_id === next.to_id,
            )
          ) {
            errors.push(this.error(mutation, "duplicate_edge", `edge already exists: ${next.from_id} ${next.rel} ${next.to_id}`));
            continue;
          }
          snapshot.edges.set(id, next);
          continue;
        }

        case "delete_edge": {
          const { id } = mutation;
          if (typeof id !== "number") {
            errors.push(this.error(mutation, "malformed_payload", "delete_edge requires id"));
            continue;
          }
          if (!snapshot.edges.has(id)) {
            errors.push(this.error(mutation, "missing_entity", `edge does not exist: ${id}`));
            continue;
          }
          snapshot.edges.delete(id);
          continue;
        }
      }
    }

    return errors;
  }

  private applyMutation(mutation: GraphMutation) {
    switch (mutation.kind) {
      case "create_work_item":
        this.db
          .prepare(
            `INSERT INTO work_items (
              id, name, kind, state, repo, issue_number, issue_url, scope_hint,
              branch, archive_path, predicted_files, actual_files, meta
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            mutation.work_item.id,
            mutation.work_item.name,
            mutation.work_item.kind,
            mutation.work_item.state ?? "planned",
            mutation.work_item.repo ?? null,
            mutation.work_item.issue_number ?? null,
            mutation.work_item.issue_url ?? null,
            mutation.work_item.scope_hint ?? null,
            mutation.work_item.branch ?? null,
            mutation.work_item.archive_path ?? null,
            JSON.stringify(mutation.work_item.predicted_files ?? []),
            JSON.stringify(mutation.work_item.actual_files ?? []),
            JSON.stringify(mutation.work_item.meta ?? {}),
          );
        return;

      case "update_work_item": {
        const assignments: string[] = [];
        const params: unknown[] = [];
        for (const [key, value] of Object.entries(mutation.patch)) {
          assignments.push(`${key} = ?`);
          if (key === "predicted_files" || key === "actual_files" || key === "meta") {
            params.push(JSON.stringify(value ?? (key === "meta" ? {} : [])));
          } else {
            params.push(value ?? null);
          }
        }
        if (assignments.length > 0) {
          assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
          this.db.prepare(`UPDATE work_items SET ${assignments.join(", ")} WHERE id = ?`).run(...params, mutation.id);
        }
        return;
      }

      case "delete_work_item":
        this.db.prepare("DELETE FROM work_items WHERE id = ?").run(mutation.id);
        return;

      case "create_edge":
        this.db
          .prepare(`INSERT INTO edges (from_id, rel, to_id, confidence, meta) VALUES (?, ?, ?, ?, ?)`)
          .run(
            mutation.edge.from_id,
            mutation.edge.rel,
            mutation.edge.to_id,
            mutation.edge.confidence ?? "certain",
            JSON.stringify(mutation.edge.meta ?? {}),
          );
        return;

      case "update_edge": {
        const assignments: string[] = [];
        const params: unknown[] = [];
        for (const [key, value] of Object.entries(mutation.patch)) {
          assignments.push(`${key} = ?`);
          params.push(key === "meta" ? JSON.stringify(value ?? {}) : value ?? null);
        }
        if (assignments.length > 0) {
          this.db.prepare(`UPDATE edges SET ${assignments.join(", ")} WHERE id = ?`).run(...params, mutation.id);
        }
        return;
      }

      case "delete_edge":
        this.db.prepare("DELETE FROM edges WHERE id = ?").run(mutation.id);
        return;
    }
  }

  private loadSnapshot(): GraphStateSnapshot {
    const workItems = new Map<string, RawWorkItemRecord>();
    const edges = new Map<number, RawEdgeRecord>();

    const workItemRows = this.db.prepare("SELECT * FROM work_items ORDER BY id").all() as RawWorkItemRecord[];
    const edgeRows = this.db.prepare("SELECT * FROM edges ORDER BY id").all() as RawEdgeRecord[];

    for (const row of workItemRows) {
      workItems.set(row.id, { ...row });
    }
    for (const row of edgeRows) {
      edges.set(row.id, { ...row });
    }

    const nextEdgeId = (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM edges").get() as { max_id: number }).max_id + 1;
    return { workItems, edges, nextEdgeId };
  }

  private getMutationOrder(kind: GraphMutation["kind"]): number {
    switch (kind) {
      case "create_work_item":
        return 1;
      case "update_work_item":
        return 2;
      case "create_edge":
        return 3;
      case "update_edge":
        return 4;
      case "delete_edge":
        return 5;
      case "delete_work_item":
        return 6;
    }
  }

  private getMutationId(mutation: GraphMutation): string {
    return mutation.mutation_id ?? `${mutation.kind}:${JSON.stringify(mutation)}`;
  }

  private error(mutation: GraphMutation, code: GraphMutationError["code"], message: string): GraphMutationError {
    return {
      mutation_id: mutation.mutation_id ?? null,
      code,
      message,
    };
  }

  private hasEdge(edges: Map<number, RawEdgeRecord>, fromId: string, rel: EdgeRel, toId: string): boolean {
    return Array.from(edges.values()).some((edge) => edge.from_id === fromId && edge.rel === rel && edge.to_id === toId);
  }

  private toRawWorkItem(input: CreateWorkItemDto): RawWorkItemRecord {
    return {
      id: input.id,
      name: input.name,
      kind: input.kind,
      state: input.state ?? "planned",
      repo: input.repo ?? null,
      issue_number: input.issue_number ?? null,
      issue_url: input.issue_url ?? null,
      scope_hint: input.scope_hint ?? null,
      branch: input.branch ?? null,
      archive_path: input.archive_path ?? null,
      predicted_files: JSON.stringify(input.predicted_files ?? []),
      actual_files: JSON.stringify(input.actual_files ?? []),
      meta: JSON.stringify(input.meta ?? {}),
      updated_at: this.now(),
    };
  }

  private toRawWorkItemPatch(input: UpdateWorkItemDto) {
    const patch: Partial<RawWorkItemRecord> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "predicted_files" || key === "actual_files" || key === "meta") {
        patch[key] = JSON.stringify(value ?? (key === "meta" ? {} : [])) as never;
      } else if (key !== "id" && key !== "updated_at") {
        patch[key as keyof RawWorkItemRecord] = (value ?? null) as never;
      }
    }
    return patch;
  }

  private toRawEdge(id: number, input: CreateEdgeDto): RawEdgeRecord {
    return {
      id,
      from_id: input.from_id,
      rel: input.rel,
      to_id: input.to_id,
      confidence: input.confidence ?? "certain",
      meta: JSON.stringify(input.meta ?? {}),
      created_at: this.now(),
    };
  }

  private toRawEdgePatch(input: UpdateEdgeDto) {
    const patch: Partial<RawEdgeRecord> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "meta") {
        patch.meta = JSON.stringify(value ?? {});
      } else if (key !== "id" && key !== "created_at") {
        patch[key as keyof RawEdgeRecord] = (value ?? null) as never;
      }
    }
    return patch;
  }

  private now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}
