import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  GitHubService,
  type GitHubListedIssue,
  type GitHubListedPullRequest,
} from "./github.service.js";

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
  /** Items written through while a listing is in flight; laid over its result. */
  writesDuringFetch: Map<number, T>;
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

    entry.writesDuringFetch = new Map();
    entry.inFlight = this.githubService.listPullRequests(key)
      .then((pulls) => {
        if (pulls.length === PULL_REQUEST_LIMIT) {
          this.logger.warn(`Pull request cache fill for ${key} hit ${PULL_REQUEST_LIMIT} items; results may be truncated`);
        }
        entry.data = this.withWrites(this.toPullRequestMap(pulls), entry.writesDuringFetch);
        entry.fetchedAt = Date.now();
        return entry.data;
      })
      .finally(() => {
        entry.inFlight = null;
      });

    return entry.inFlight;
  }

  async listIssues(repo: string): Promise<Map<number, CachedIssue>> {
    const key = this.normalizeRepo(repo);
    const entry = this.getOrCreateEntry(this.issueCache, key);
    if (this.isFresh(entry)) return entry.data;
    if (entry.inFlight) return entry.inFlight;

    entry.writesDuringFetch = new Map();
    entry.inFlight = this.githubService.listIssues(key)
      .then((issues) => {
        if (issues.length === ISSUE_LIMIT) {
          this.logger.warn(`Issue cache fill for ${key} hit ${ISSUE_LIMIT} items; results may be truncated`);
        }
        entry.data = this.withWrites(this.toIssueMap(issues), entry.writesDuringFetch);
        entry.fetchedAt = Date.now();
        return entry.data;
      })
      .finally(() => {
        entry.inFlight = null;
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
    this.writeThrough(entry, pr.number, { ...pr });
  }

  upsertIssue(repo: string, issue: CachedIssue): void {
    const key = this.normalizeRepo(repo);
    const entry = this.getOrCreateEntry(this.issueCache, key);
    this.writeThrough(entry, issue.number, { ...issue });
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
      writesDuringFetch: new Map<number, T>(),
    };
    cache.set(repo, created);
    return created;
  }

  /**
   * Store one item without claiming the listing is fresh: an entry that
   * was never filled stays unfilled, so the next list read still fetches
   * (#292: the sweep writes single items into caches nobody has listed).
   */
  private writeThrough<T>(entry: CacheEntry<T>, number: number, item: T): void {
    entry.data.set(number, item);
    if (entry.inFlight) entry.writesDuringFetch.set(number, item);
  }

  /** A listing that was in flight during a write is older than the write. */
  private withWrites<T>(listing: Map<number, T>, writes: Map<number, T>): Map<number, T> {
    for (const [number, item] of writes) listing.set(number, item);
    return listing;
  }

  private toPullRequestMap(pulls: GitHubListedPullRequest[]): Map<number, CachedPullRequest> {
    return new Map(pulls.map((pull) => [pull.number, { ...pull }]));
  }

  private toIssueMap(issues: GitHubListedIssue[]): Map<number, CachedIssue> {
    return new Map(issues.map((issue) => [issue.number, { ...issue }]));
  }
}
