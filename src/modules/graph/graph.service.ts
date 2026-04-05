import { Inject, Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { buildDispatchPlan, queryFrontier } from "../../lib/manifest-core.js";
import { SQLiteService } from "./sqlite.service.js";
import type { GraphFilters, WorkItemRecord } from "./types.js";
import { WorkItemsService } from "./work-items.service.js";

@Injectable()
export class GraphService {
  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
  ) {}

  private get db(): DatabaseType {
    return this.sqlite.getDb();
  }

  getGraph(filters: GraphFilters = {}) {
    const items = this.getFilteredItems(filters);
    const itemIds = items.map((item) => item.id);

    const edges = itemIds.length === 0
      ? []
      : (this.db
          .prepare(
            `SELECT * FROM edges WHERE from_id IN (${itemIds.map(() => "?").join(",")}) AND to_id IN (${itemIds
              .map(() => "?")
              .join(",")}) ORDER BY id`
          )
          .all(...itemIds, ...itemIds) as Array<{
            id: number;
            from_id: string;
            rel: string;
            to_id: string;
            confidence: string;
            meta: string;
            created_at: string;
          }>)
          .map((edge) => ({
            ...edge,
            meta: this.parseMeta(edge.meta),
          }));

    return {
      filters,
      graph_version: this.sqlite.getGraphVersion(),
      items,
      edges,
    };
  }

  getFrontier(repo?: string) {
    const frontier = queryFrontier(this.db);
    return repo ? frontier.filter((item) => item.repo === repo) : frontier;
  }

  getPlan(repo?: string) {
    const plan = buildDispatchPlan(this.db);
    if (!repo) {
      return plan;
    }

    return {
      ...plan,
      parallel_groups: plan.parallel_groups.filter((group) => group.repo === repo),
    };
  }

  private getFilteredItems(filters: GraphFilters): WorkItemRecord[] {
    let items = this.workItems.list({ repo: filters.repo, state: filters.state });

    if (filters.track) {
      const ids = new Set(this.findMembersOf(filters.track));
      items = items.filter((item) => ids.has(item.id) || item.id === filters.track);
    }

    if (filters.phase) {
      const ids = new Set(this.findMembersOfPhase(filters.phase));
      items = items.filter((item) => ids.has(item.id) || item.id === filters.phase);
    }

    return items;
  }

  private parseMeta(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private findMembersOf(trackId: string): string[] {
    const rows = this.db
      .prepare("SELECT from_id FROM edges WHERE rel = 'is_part_of' AND to_id = ?")
      .all(trackId) as Array<{ from_id: string }>;
    return rows.map((row) => row.from_id);
  }

  private findMembersOfPhase(phaseId: string): string[] {
    const trackRows = this.db
      .prepare("SELECT from_id FROM edges WHERE rel = 'is_part_of' AND to_id = ?")
      .all(phaseId) as Array<{ from_id: string }>;

    const ids = new Set<string>();
    for (const track of trackRows) {
      ids.add(track.from_id);
      for (const member of this.findMembersOf(track.from_id)) {
        ids.add(member);
      }
    }

    return Array.from(ids);
  }
}
