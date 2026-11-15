import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { WorkItemsService } from "../graph/work-items.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { GitHubBatchCache } from "./github-batch-cache.service.js";

/** An open GitHub issue with no work item in the graph. */
export interface UntrackedIssue {
  repo: string;
  issue_number: number;
  title: string;
  issue_url: string;
  /** The work-item ID an import would create. */
  derived_id: string;
  /** State an imported node starts in. */
  initial_state: "planned";
  /** Set when `derived_id` is already taken by another work item; such an issue cannot be imported. */
  conflict: string | null;
}

export interface UntrackedIssuesResult {
  repo: string;
  /** Open issues on GitHub, tracked or not. */
  open_issues: number;
  candidates: UntrackedIssue[];
}

/**
 * Discovery of GitHub issues the graph does not know (#281).
 *
 * Repos come from Settings (included repos), not from existing work
 * items, so a connected repo with nothing in the graph can be scanned.
 * An issue counts as tracked when any work item has the same repo and
 * issue number, whatever its state. Nothing is imported here.
 */
@Injectable()
export class UntrackedIssuesService {
  constructor(
    @Inject(GitHubBatchCache) private readonly cache: GitHubBatchCache,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async list(repo: string, options: { refresh?: boolean } = {}): Promise<UntrackedIssuesResult> {
    const slug = this.requireIncludedRepo(repo);
    if (options.refresh) this.cache.invalidate(slug);
    const issues = await this.cache.listIssues(slug);

    const tracked = new Set<number>();
    for (const item of this.workItems.list({ repo: slug })) {
      if (item.issue_number != null) tracked.add(item.issue_number);
    }
    const takenIds = new Map(this.workItems.list().map((item) => [item.id, item]));

    const candidates: UntrackedIssue[] = [];
    let open = 0;
    for (const issue of issues.values()) {
      if (issue.state !== "open") continue;
      open += 1;
      if (tracked.has(issue.number)) continue;
      const derivedId = this.workItems.deriveIssueId(slug, issue.number);
      const holder = takenIds.get(derivedId);
      candidates.push({
        repo: slug,
        issue_number: issue.number,
        title: issue.title,
        issue_url: issue.url,
        derived_id: derivedId,
        initial_state: "planned",
        conflict: holder
          ? `ID ${derivedId} is already used by "${holder.name}"${holder.repo ? ` (${holder.repo})` : ""}`
          : null,
      });
    }
    candidates.sort((left, right) => right.issue_number - left.issue_number);
    return { repo: slug, open_issues: open, candidates };
  }

  /** The repo slug as stored in Settings, or 400 when it is not an included repo. */
  requireIncludedRepo(repo: string): string {
    const slug = this.findIncludedRepo(repo);
    if (!slug) throw new BadRequestException(`Repository is not included in Settings: ${repo || "(none)"}`);
    return slug;
  }

  /** The slug Settings uses for `repo` (matched case-insensitively), or null. */
  findIncludedRepo(repo: string): string | null {
    const wanted = `${repo ?? ""}`.trim().toLowerCase();
    if (!wanted) return null;
    return this.settings.listIncludedRepos().find((included) => included.toLowerCase() === wanted) ?? null;
  }
}
