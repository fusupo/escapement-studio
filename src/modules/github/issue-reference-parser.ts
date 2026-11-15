/**
 * Explicit relationship references in a GitHub issue body (#281).
 *
 * Only statements the author wrote count: a keyword directly followed
 * by one or more issue references. Nothing is inferred from a bare
 * mention ("see #12"). The result is evidence for proposed edges; the
 * caller decides which references resolve to work items.
 */

export interface IssueReference {
  rel: "depends_on" | "is_part_of";
  /**
   * "outgoing": this issue depends on / is part of the target.
   * "incoming": the target depends on / is part of this issue
   * ("blocks #12", a task-list entry that is only "- [ ] #12").
   */
  direction: "outgoing" | "incoming";
  /** Repo of the referenced issue; null when the reference is a work-item ID. */
  repo: string | null;
  issue_number: number | null;
  /** A literal work-item ID such as "studio-180", when that is what the text names. */
  work_item_id: string | null;
  /** The line the reference was found on, trimmed. */
  quote: string;
}

const REF = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+`;
const REF_LIST = String.raw`(?:${REF})(?:\s*(?:,|and|&)\s*(?:${REF}))*`;

const KEYWORDS: Array<{ pattern: string; rel: IssueReference["rel"]; direction: IssueReference["direction"] }> = [
  { pattern: String.raw`depends?\s+on|blocked\s+by|requires`, rel: "depends_on", direction: "outgoing" },
  { pattern: String.raw`blocks|blocking`, rel: "depends_on", direction: "incoming" },
  { pattern: String.raw`part\s+of|sub-?issue\s+of|child\s+of|parent(?:\s+issue)?|epic`, rel: "is_part_of", direction: "outgoing" },
];

// A task-list entry names a child only when the references are the whole
// entry; "- [ ] #12 is closed when this lands" is a to-do that mentions #12.
const TASK_LIST_ITEM = new RegExp(String.raw`^\s*[-*]\s+\[[ xX]\]\s+(${REF_LIST})\s*$`);
const QUOTE_LIMIT = 200;

/** Parse the relationship references in `body`. `repo` is the issue's own repo, used for bare `#N`. */
export function parseIssueReferences(body: string | null | undefined, repo: string): IssueReference[] {
  const found = new Map<string, IssueReference>();
  const add = (rel: IssueReference["rel"], direction: IssueReference["direction"], refs: string, line: string) => {
    for (const match of refs.matchAll(new RegExp(REF, "g"))) {
      const target = parseTarget(match[0], repo);
      if (!target) continue;
      const key = [rel, direction, target.repo?.toLowerCase() ?? "", target.issue_number ?? "", target.work_item_id ?? ""].join("|");
      if (!found.has(key)) found.set(key, { rel, direction, ...target, quote: quote(line) });
    }
  };

  let fenced = false;
  for (const line of `${body ?? ""}`.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const keyword of KEYWORDS) {
      const pattern = new RegExp(String.raw`(?<![\w-])(?:${keyword.pattern})\s*:?\s+(${REF_LIST})`, "gi");
      for (const match of line.matchAll(pattern)) add(keyword.rel, keyword.direction, match[1], line);
    }
    const task = TASK_LIST_ITEM.exec(line);
    if (task) add("is_part_of", "incoming", task[1], line);
  }
  return [...found.values()];
}

function parseTarget(ref: string, repo: string): Pick<IssueReference, "repo" | "issue_number" | "work_item_id"> | null {
  const url = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(ref);
  if (url) return { repo: url[1], issue_number: Number(url[2]), work_item_id: null };
  const hash = /^([\w.-]+\/[\w.-]+)?#(\d+)$/.exec(ref);
  if (hash) return { repo: hash[1] ?? repo, issue_number: Number(hash[2]), work_item_id: null };
  if (/^[A-Za-z][A-Za-z0-9-]*-\d+$/.test(ref)) return { repo: null, issue_number: null, work_item_id: ref };
  return null;
}

function quote(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > QUOTE_LIMIT ? `${trimmed.slice(0, QUOTE_LIMIT - 1)}…` : trimmed;
}
