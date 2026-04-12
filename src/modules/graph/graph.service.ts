import { Inject, Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  buildParallelGroups,
  buildSequentialNodes,
  buildValidationPolicy,
  determineMergeOrder,
  parseJsonArray,
  queryBlocked,
  queryHumanGated,
  queryOverlaps,
} from "../../lib/manifest-core.js";
import type { Assessment, DispatchPlan, FrontierItem } from "../../lib/manifest-core.js";
import { SQLiteService } from "./sqlite.service.js";
import type { GraphFilters, WorkItemRecord } from "./types.js";
import { WorkItemsService } from "./work-items.service.js";

/**
 * Studio-local frontier query.
 *
 * The upstream `queryFrontier` in `escapement/src/core/planner.ts` hard-codes
 * `state = 'planned'`. Under ADR 014, Studio promotes `ready` to a launchable
 * state alongside `planned` (see `docs/adr/014-plans-runs-state-model.md`
 * transition table — `ready → in_progress` is a valid launch transition).
 *
 * This helper mirrors the upstream SQL exactly except it widens the state
 * filter to `state IN ('planned', 'ready')`. If the upstream planner is
 * updated to support multi-state frontiers, this helper should be replaced
 * with a direct upstream call.
 */
function queryStudioFrontier(db: DatabaseType): FrontierItem[] {
  const sql = `
    SELECT w.id, w.name, w.kind, w.repo, w.scope_hint, w.branch,
           w.issue_url, w.predicted_files
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state IN ('planned', 'ready')
      AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
      AND NOT EXISTS (
        SELECT 1
        FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state NOT IN ('done', 'archived')
      )
    ORDER BY w.id
  `;
  const rows = db.prepare(sql).all() as (Omit<FrontierItem, "predicted_files"> & {
    predicted_files: string;
  })[];
  return rows.map((r) => ({
    ...r,
    predicted_files: parseJsonArray(r.predicted_files),
  }));
}

/**
 * Studio-local dispatch plan builder.
 *
 * Reimplements the upstream `buildDispatchPlan` verbatim except it sources
 * its frontier from `queryStudioFrontier` (which includes `ready` items).
 * All other planner helpers (`queryOverlaps`, `queryBlocked`, etc.) are
 * state-agnostic and reused unchanged.
 */
function buildStudioDispatchPlan(
  db: DatabaseType,
  assessments?: Map<string, Assessment>,
): DispatchPlan {
  const frontier = queryStudioFrontier(db);
  const overlaps = queryOverlaps(db);
  const blocked = queryBlocked(db);
  const humanGated = queryHumanGated(db);

  const groups = buildParallelGroups(frontier, overlaps, assessments);
  for (const group of groups) {
    const order = determineMergeOrder(group);
    if (order) group.merge_order = order;
  }

  const validationPolicy = buildValidationPolicy(groups);
  const sequential = buildSequentialNodes(blocked);

  const assumptions: string[] = [];
  if (!assessments || assessments.size === 0) {
    assumptions.push(
      "No conflict classifications provided -- all shared files treated as 'unknown' (conservative)",
    );
  }
  if (frontier.some((f) => f.predicted_files.length === 0)) {
    assumptions.push(
      "Some frontier items have no predicted files -- they are assumed to have no file conflicts",
    );
  }

  return {
    generated_at: new Date().toISOString(),
    assumptions,
    parallel_groups: groups,
    sequential,
    validation_policy: validationPolicy,
    summary: {
      frontier_count: frontier.length + blocked.length + humanGated.length,
      dispatchable_now: frontier.length,
      blocked_count: blocked.length,
      human_gate_count: humanGated.length,
    },
  };
}

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
    const frontier = queryStudioFrontier(this.db);
    return repo ? frontier.filter((item) => item.repo === repo) : frontier;
  }

  getPlan(repo?: string) {
    const plan = buildStudioDispatchPlan(this.db);
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
