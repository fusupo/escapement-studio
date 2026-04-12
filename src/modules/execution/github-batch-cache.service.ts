import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  GitHubService,
  type GitHubListedIssue,
  type GitHubListedPullRequest,
} from "../github/github.service.js";

export interface CachedPullRequest {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged_at: string | null;
  head_ref: string;
  base_ref: string;
  url: string;
  title: string;
  is_draft: boolean;
}

export interface CachedIssue {
  number: number;
  state: "open" | "closed";
  closed_at: string | null;
  url: string;
  title: string;
}

interface CacheEntry<T> {
  fetchedAt: number | null;
  data: Map<number, T>;
  inFlight: Promise<Map<number, T>> | null;
  generation: number;
}

const PULL_REQUEST_LIMIT = 300;
const ISSUE_LIMIT = 500;

@Injectable()
export class GitHubBatchCache {
  private readonly logger = new Logger(GitHubBatchCache.name);
  private readonly ttlMs = 60_000;
  private readonly prCache = new Map<string, CacheEntry<CachedPullRequest>>();
  private readonly issueCache = new Map<string, CacheEntry<CachedIssue>>();

  constructor(@Inject(GitHubService) private readonly githubService: GitHubService) {}

  async listPullRequests(repo: string): Promise<Map<number, CachedPullRequest>> {
    const key = this.normalizeRepo(repo);
    const entry = this.getOrCreateEntry(this.prCache, key);
    if (this.isFresh(entry)) return entry.data;
    if (entry.inFlight) return entry.inFlight;

    const fetchGeneration = entry.generation;
    entry.inFlight = this.githubService.listPullRequests(key)
      .then((pulls) => {
        if (pulls.length === PULL_REQUEST_LIMIT) {
          this.logger.warn(`Pull request cache fill for ${key} hit ${PULL_REQUEST_LIMIT} items; results may be truncated`);
        }
        const nextData = this.toPullRequestMap(pulls);
        if (entry.generation === fetchGeneration) {
          entry.data = nextData;
          entry.fetchedAt = Date.now();
        }
        return entry.data;
      })
      .finally(() => {
        if (entry.inFlight) {
          entry.inFlight = null;
        }
      });

    return entry.inFlight;
  }

  async listIssues(repo: string): Promise<Map<number, CachedIssue>> {
    const key = this.normalizeRepo(repo);
    const entry = this.getOrCreateEntry(this.issueCache, key);
    if (this.isFresh(entry)) return entry.data;
    if (entry.inFlight) return entry.inFlight;

    const fetchGeneration = entry.generation;
    entry.inFlight = this.githubService.listIssues(key)
      .then((issues) => {
        if (issues.length === ISSUE_LIMIT) {
          this.logger.warn(`Issue cache fill for ${key} hit ${ISSUE_LIMIT} items; results may be truncated`);
        }
        const nextData = this.toIssueMap(issues);
        if (entry.generation === fetchGeneration) {
          entry.data = nextData;
          entry.fetchedAt = Date.now();
        }
        return entry.data;
      })
      .finally(() => {
        if (entry.inFlight) {
          entry.inFlight = null;
        }
      });

    return entry.inFlight;
  }

  async findPullRequestForBranch(repo: string, branch: string): Promise<CachedPullRequest | null> {
    const normalizedBranch = branch.trim();
    if (!normalizedBranch) return null;
    const pulls = await this.listPullRequests(repo);
    for (const pull of pulls.values()) {
      if (pull.head_ref === normalizedBranch) {
        return pull;
      }
    }
    return null;
  }

  upsertPullRequest(repo: string, pr: CachedPullRequest): void {
    const key = this.normalizeRepo(repo);
    const entry = this.getOrCreateEntry(this.prCache, key);
    entry.generation += 1;
    entry.data.set(pr.number, { ...pr });
    entry.fetchedAt ??= Date.now();
  }

  upsertIssue(repo: string, issue: CachedIssue): void {
    const key = this.normalizeRepo(repo);
    const entry = this.getOrCreateEntry(this.issueCache, key);
    entry.generation += 1;
    entry.data.set(issue.number, { ...issue });
    entry.fetchedAt ??= Date.now();
  }

  invalidate(repo: string): void {
    const key = this.normalizeRepo(repo);
    this.prCache.delete(key);
    this.issueCache.delete(key);
  }

  invalidateAll(): void {
    this.prCache.clear();
    this.issueCache.clear();
  }

  getCacheInfo(): Array<{
    repo: string;
    prs_fetched_at: string | null;
    issues_fetched_at: string | null;
    pr_count: number;
    issue_count: number;
  }> {
    const repos = new Set([...this.prCache.keys(), ...this.issueCache.keys()]);
    return Array.from(repos)
      .sort((a, b) => a.localeCompare(b))
      .map((repo) => {
        const prs = this.prCache.get(repo);
        const issues = this.issueCache.get(repo);
        return {
          repo,
          prs_fetched_at: prs?.fetchedAt ? new Date(prs.fetchedAt).toISOString() : null,
          issues_fetched_at: issues?.fetchedAt ? new Date(issues.fetchedAt).toISOString() : null,
          pr_count: prs?.data.size ?? 0,
          issue_count: issues?.data.size ?? 0,
        };
      });
  }

  private normalizeRepo(repo: string): string {
    return this.githubService.normalizeRepo(repo);
  }

  private isFresh<T>(entry: CacheEntry<T>): boolean {
    return entry.fetchedAt !== null && Date.now() - entry.fetchedAt < this.ttlMs;
  }

  private getOrCreateEntry<T>(cache: Map<string, CacheEntry<T>>, repo: string): CacheEntry<T> {
    const existing = cache.get(repo);
    if (existing) return existing;
    const created: CacheEntry<T> = {
      fetchedAt: null,
      data: new Map<number, T>(),
      inFlight: null,
      generation: 0,
    };
    cache.set(repo, created);
    return created;
  }

  private toPullRequestMap(pulls: GitHubListedPullRequest[]): Map<number, CachedPullRequest> {
    return new Map(pulls.map((pull) => [pull.number, { ...pull }]));
  }

  private toIssueMap(issues: GitHubListedIssue[]): Map<number, CachedIssue> {
    return new Map(issues.map((issue) => [issue.number, { ...issue }]));
  }
}
