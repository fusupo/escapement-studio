/**
 * Cycle detection for graph edges (#281).
 *
 * `depends_on` and `is_part_of` must each stay acyclic: a dependency loop
 * leaves every item in it permanently blocked, and a containment loop has
 * no root. Relations are checked independently.
 */

export interface CycleEdge {
  from_id: string;
  rel: string;
  to_id: string;
}

export const ACYCLIC_RELATIONS: ReadonlySet<string> = new Set(["depends_on", "is_part_of"]);

/**
 * If `candidate` closes a cycle among `edges` of the same relation, return
 * the cycle as a list of ids starting and ending at `candidate.from_id`.
 * Returns null when the relation is not required to be acyclic or no cycle
 * runs through the candidate. `edges` may or may not already contain the
 * candidate. Cycles that do not pass through the candidate are ignored, so
 * a loop already in the graph does not block unrelated edits.
 */
export function findCycleThrough(edges: Iterable<CycleEdge>, candidate: CycleEdge): string[] | null {
  if (!ACYCLIC_RELATIONS.has(candidate.rel)) return null;
  if (candidate.from_id === candidate.to_id) return [candidate.from_id, candidate.to_id];

  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.rel !== candidate.rel) continue;
    const targets = next.get(edge.from_id);
    if (targets) targets.push(edge.to_id);
    else next.set(edge.from_id, [edge.to_id]);
  }

  // Breadth-first from the candidate's target back to its source.
  const cameFrom = new Map<string, string | null>([[candidate.to_id, null]]);
  const queue = [candidate.to_id];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === candidate.from_id) {
      const path: string[] = [];
      for (let node: string | null = current; node !== null; node = cameFrom.get(node) ?? null) path.push(node);
      return [candidate.from_id, ...path.reverse()];
    }
    for (const target of next.get(current) ?? []) {
      if (cameFrom.has(target)) continue;
      cameFrom.set(target, current);
      queue.push(target);
    }
  }
  return null;
}
