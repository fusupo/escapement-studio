import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { EventBus } from "@nestjs/cqrs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PullRequestTruthRefreshedEvent } from "../execution/events/pull-request-truth-refreshed.event.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import { GitHubIssueBodySyncService } from "./github-issue-body-sync.service.js";
import type { UpdateWorkItemDto, WorkItemRecord } from "../graph/types.js";
import type {
  GitHubIssueDetails,
  GitHubIssueAssignee,
  GitHubIssueLabel,
  GitHubSyncApplyResult,
  GitHubSyncProposal,
} from "../planning/types.js";

interface RawIssueResponse {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels?: Array<{ name?: string; description?: string; color?: string }>;
  assignees?: Array<{ login?: string; name?: string }>;
}

interface RawIssueListResponse {
  number: number;
  title: string;
  url: string;
  state: string;
  closedAt?: string | null;
}

interface RawPullRequestResponse {
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
}

export interface GitHubListedPullRequest {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged_at: string | null;
  head_ref: string;
  base_ref: string;
  url: string;
  title: string;
  is_draft: boolean;
}

export interface GitHubListedIssue {
  number: number;
  state: "open" | "closed";
  closed_at: string | null;
  url: string;
  title: string;
}

export interface GitHubCreateIssueInput {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

export interface GitHubCreatedIssue {
  repo: string;
  number: number;
  url: string;
  title: string;
}

export interface GitHubDeletedIssue {
  repo: string;
  number: number;
  deleted: true;
}

export interface GitHubPullRequestDetails {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  is_draft: boolean;
  base_ref: string;
  head_ref: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  reconciliation?: {
    updated_work_item_ids: string[];
    work_items: WorkItemRecord[];
  };
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(GitHubIssueBodySyncService) private readonly issueBodySync: GitHubIssueBodySyncService,
  ) {}

  async createIssue(input: GitHubCreateIssueInput): Promise<GitHubCreatedIssue> {
    const { repo, title, body, labels } = input;
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!title?.trim()) {
      throw new BadRequestException("title is required");
    }

    const args = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
    ];

    if (body) {
      args.push("--body", body);
    }

    if (labels && labels.length > 0) {
      args.push("--label", labels.join(","));
    }

    const stdout = this.runGh(args).trim();

    // gh issue create outputs the issue URL, e.g. https://github.com/owner/repo/issues/42
    const issueNumberMatch = stdout.match(/\/issues\/(\d+)\s*$/);
    if (!issueNumberMatch) {
      throw new BadRequestException(`Could not parse issue number from gh output: ${stdout}`);
    }

    const issueNumber = Number(issueNumberMatch[1]);
    return {
      repo,
      number: issueNumber,
      url: stdout,
      title,
    };
  }

  async closeIssue(repo: string, issueNumber: number, comment?: string | null): Promise<GitHubIssueDetails> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new BadRequestException("issue_number must be a positive integer");
    }

    const trimmedComment = typeof comment === "string" ? comment.trim() : "";
    if (trimmedComment) {
      this.runGh([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        trimmedComment,
      ]);
    }

    this.runGh([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
    ]);

    return this.readIssue(repo, issueNumber);
  }

  async deleteIssue(repo: string, issueNumber: number): Promise<GitHubDeletedIssue> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new BadRequestException("issue_number must be a positive integer");
    }

    this.runGh([
      "issue",
      "delete",
      String(issueNumber),
      "--repo",
      repo,
      "--yes",
    ]);

    return {
      repo,
      number: issueNumber,
      deleted: true,
    };
  }

  async readIssue(repo: string, issueNumber: number): Promise<GitHubIssueDetails> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new BadRequestException("issue_number must be a positive integer");
    }

    const raw = await this.runGhJson<RawIssueResponse>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "number,title,body,url,state,labels,assignees",
    ]);

    const body = raw.body ?? "";
    const managedBlock = this.issueBodySync.extractManagedBlock(body);
    const labels = this.normalizeIssueLabels((raw.labels ?? []).map((label): GitHubIssueLabel => ({
      name: label.name ?? "",
      description: label.description,
      color: label.color,
    })).filter((label) => Boolean(label.name)));
    const assignees = this.normalizeIssueAssignees((raw.assignees ?? []).map((assignee): GitHubIssueAssignee => ({
      login: assignee.login ?? "",
      name: assignee.name,
    })).filter((assignee) => Boolean(assignee.login)));

    const details: GitHubIssueDetails = {
      repo,
      number: raw.number,
      title: raw.title,
      body,
      url: raw.url,
      state: raw.state,
      labels,
      assignees,
      body_hash: this.hash(body),
      managed_block: managedBlock,
    };

    return {
      ...details,
      reconciliation: this.reconcileIssueTruth(details),
    };
  }

  async readPullRequest(repo: string, pullRequestNumber: number): Promise<GitHubPullRequestDetails> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
      throw new BadRequestException("pull_request_number must be a positive integer");
    }

    const raw = await this.runGhJson<RawPullRequestResponse>([
      "pr",
      "view",
      String(pullRequestNumber),
      "--repo",
      repo,
      "--json",
      "number,url,title,body,state,isDraft,baseRefName,headRefName,mergedAt,mergeCommit",
    ]);

    return this.withPullRequestReconciliation(this.toPullRequestDetails(repo, raw));
  }

  normalizeRepo(repo: string): string {
    const trimmed = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^github\.com\//i, "");
    return trimmed.replace(/^\/+|\/+$/g, "").toLowerCase();
  }

  async listPullRequests(repo: string): Promise<GitHubListedPullRequest[]> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }

    const normalizedRepo = this.normalizeRepo(repo);
    const pulls = await this.runGhJson<RawPullRequestResponse[]>([
      "pr",
      "list",
      "--repo",
      normalizedRepo,
      "--state",
      "all",
      "--limit",
      "300",
      "--json",
      "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt",
    ]);

    if (pulls.length === 300) {
      this.logger.warn(`gh pr list hit --limit 300 for ${normalizedRepo}; results may be truncated`);
    }

    return pulls.map((pull) => {
      const details = this.toPullRequestDetails(normalizedRepo, pull);
      return {
        number: details.number,
        state: this.normalizePullRequestState(details.state, details.merged_at),
        merged_at: details.merged_at,
        head_ref: details.head_ref,
        base_ref: details.base_ref,
        url: details.url,
        title: details.title,
        is_draft: details.is_draft,
      };
    });
  }

  async listIssues(repo: string): Promise<GitHubListedIssue[]> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }

    const normalizedRepo = this.normalizeRepo(repo);
    const issues = await this.runGhJson<RawIssueListResponse[]>([
      "issue",
      "list",
      "--repo",
      normalizedRepo,
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "number,title,url,state,closedAt",
    ]);

    if (issues.length === 500) {
      this.logger.warn(`gh issue list hit --limit 500 for ${normalizedRepo}; results may be truncated`);
    }

    return issues.map((issue) => ({
      number: issue.number,
      state: `${issue.state}`.toLowerCase() === "closed" ? "closed" : "open",
      closed_at: issue.closedAt ?? null,
      url: issue.url,
      title: issue.title,
    }));
  }

  async findPullRequestForBranch(repo: string, branch: string): Promise<GitHubPullRequestDetails | null> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!branch?.trim()) {
      throw new BadRequestException("branch is required");
    }

    const pulls = await this.runGhJson<RawPullRequestResponse[]>([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,title,body,state,isDraft,baseRefName,headRefName,mergedAt,mergeCommit",
    ]);

    const exactMatches = pulls
      .map((pull) => this.toPullRequestDetails(repo, pull))
      .filter((pull) => pull.head_ref === branch)
      .sort((left, right) => (right.merged_at ?? "").localeCompare(left.merged_at ?? "") || right.number - left.number);

    if (!exactMatches[0]) {
      return null;
    }

    return this.withPullRequestReconciliation(exactMatches[0]);
  }

  async stageManagedBlockSync(workItemId: string) {
    return this.issueBodySync.stageManagedBlockSync(workItemId, (repo, issueNumber) => this.readIssue(repo, issueNumber));
  }

  async stageIssueBodySync(workItemId: string, bodyAfter: string) {
    return this.issueBodySync.stageIssueBodySync(workItemId, bodyAfter, (repo, issueNumber) => this.readIssue(repo, issueNumber));
  }

  async applySyncProposal(proposal: GitHubSyncProposal, approvedOperationIds: string[]): Promise<{ result: GitHubSyncApplyResult; issue: GitHubIssueDetails | null }> {
    const issue = await this.readIssue(proposal.issue.repo, proposal.issue.issue_number);
    if (issue.body_hash !== proposal.based_on_body_hash) {
      return {
        result: {
          status: "stale",
          previous_body_hash: proposal.based_on_body_hash,
          current_body_hash: issue.body_hash,
          message: "GitHub issue body changed since this sync was staged and must be regenerated.",
        },
        issue,
      };
    }

    const nextBody = this.issueBodySync.buildApprovedBody(issue, proposal, approvedOperationIds);
    if (!nextBody.ok) {
      return {
        result: {
          status: "validation_failed",
          errors: nextBody.errors,
        },
        issue,
      };
    }

    await this.runGh([
      "issue",
      "edit",
      String(proposal.issue.issue_number),
      "--repo",
      proposal.issue.repo,
      "--body-file",
      "-",
    ], nextBody.body);

    const updatedIssue = await this.readIssue(proposal.issue.repo, proposal.issue.issue_number);
    return {
      result: {
        status: "applied",
        applied_operation_ids: nextBody.applied_operation_ids,
        previous_body_hash: issue.body_hash,
        new_body_hash: updatedIssue.body_hash,
      },
      issue: updatedIssue,
    };
  }

  private withPullRequestReconciliation(pullRequest: GitHubPullRequestDetails): GitHubPullRequestDetails {
    const workItems = this.findLinkedPullRequestWorkItems(pullRequest);
    const updatedWorkItemIds: string[] = [];
    const nextWorkItems = workItems.map((workItem) => {
      const existingMeta = this.readObject(workItem.meta);
      const nextMeta = { ...existingMeta };
      let changed = false;

      const nextPrimaryPullRequest = this.mergeStoredPullRequest(existingMeta.pull_request, pullRequest);
      if (!this.samePullRequestSnapshot(existingMeta.pull_request, pullRequest)) {
        nextMeta.pull_request = nextPrimaryPullRequest;
        changed = true;
      }

      const existingPostMergeSync = this.readObject(existingMeta.studio_post_merge_sync);
      if (Object.keys(existingPostMergeSync).length > 0) {
        const existingPostMergePullRequest = existingPostMergeSync.pull_request;
        if (!this.samePullRequestSnapshot(existingPostMergePullRequest, pullRequest)) {
          nextMeta.studio_post_merge_sync = {
            ...existingPostMergeSync,
            pull_request: this.mergeStoredPullRequest(existingPostMergePullRequest, pullRequest),
          };
          changed = true;
        }
      }

      const updatePatch: UpdateWorkItemDto = { meta: nextMeta };
      // Narrowly advance open_pr → merged_pr when GitHub truth shows the PR merged.
      // Keep the guard strict on 'open_pr' so already-merged_pr items stay stable and
      // unrelated states (in_progress, ready, done, ...) are never rewritten. The fuller
      // ExecutionService.syncMergedPullRequest flow still owns runs / actual_files /
      // archive_path / studio_post_merge_sync and remains the source of truth for those.
      if (pullRequest.merged_at && workItem.state === "open_pr") {
        updatePatch.state = "merged_pr";
        changed = true;
      }

      if (!changed) {
        return workItem;
      }

      updatedWorkItemIds.push(workItem.id);
      return this.workItems.update(workItem.id, updatePatch);
    });

    // Phase 5 (#225): publish a PullRequestTruthRefreshedEvent so
    // PullRequestService (via PullRequestTruthRefreshedHandler) can
    // update the run store. Replaces the previous
    // `registerPullRequestTruthRefresher` callback handshake.
    // EventBus is synchronous in-process, so the handler runs before
    // `publish` returns — the semantics match the old direct callback
    // from this caller's point of view.
    this.eventBus.publish(
      new PullRequestTruthRefreshedEvent(
        pullRequest,
        nextWorkItems.map((workItem) => workItem.id),
      ),
    );

    return {
      ...pullRequest,
      reconciliation: {
        updated_work_item_ids: updatedWorkItemIds,
        work_items: nextWorkItems,
      },
    };
  }

  private findLinkedPullRequestWorkItems(pullRequest: GitHubPullRequestDetails): WorkItemRecord[] {
    const byId = new Map<string, WorkItemRecord>();
    for (const workItem of this.workItems.listByRepoPullRequestNumber(pullRequest.repo, pullRequest.number)) {
      byId.set(workItem.id, workItem);
    }
    for (const workItem of this.workItems.listByRepoBranch(pullRequest.repo, pullRequest.head_ref)) {
      byId.set(workItem.id, workItem);
    }
    return Array.from(byId.values());
  }

  private reconcileIssueTruth(issue: GitHubIssueDetails): { updated_work_item_ids: string[]; work_items: WorkItemRecord[] } {
    const linkedWorkItems = this.workItems.listByRepoIssueNumber(issue.repo, issue.number);
    const updatedWorkItemIds: string[] = [];
    const nextWorkItems = linkedWorkItems.map((workItem) => {
      const existingMeta = this.readObject(workItem.meta);
      const nextIssueMeta = {
        ...this.readObject(existingMeta.github_issue),
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        labels: this.normalizeIssueLabels(issue.labels),
        assignees: this.normalizeIssueAssignees(issue.assignees),
        body_hash: issue.body_hash,
        managed_block: issue.managed_block ?? null,
        synced_at: this.now(),
      };

      if (workItem.issue_url === issue.url && this.sameIssueSnapshot(existingMeta.github_issue, issue)) {
        return workItem;
      }

      updatedWorkItemIds.push(workItem.id);
      return this.workItems.update(workItem.id, {
        issue_url: issue.url,
        meta: {
          ...existingMeta,
          github_issue: nextIssueMeta,
        },
      });
    });

    return {
      updated_work_item_ids: updatedWorkItemIds,
      work_items: nextWorkItems,
    };
  }


  private samePullRequestSnapshot(stored: unknown, pullRequest: GitHubPullRequestDetails): boolean {
    const snapshot = this.readObject(stored);
    return this.readNumber(snapshot.number) === pullRequest.number
      && this.normalizeNullableString(snapshot.url) === pullRequest.url
      && this.normalizeNullableString(snapshot.title) === pullRequest.title
      && this.normalizeNullableString(snapshot.state) === pullRequest.state
      && this.normalizeNullableString(snapshot.base_ref) === pullRequest.base_ref
      && this.normalizeNullableString(snapshot.head_ref) === pullRequest.head_ref
      && this.readBoolean(snapshot.is_draft) === pullRequest.is_draft
      && this.normalizeNullableString(snapshot.merged_at) === (pullRequest.merged_at ?? null)
      && this.normalizeNullableString(snapshot.merge_commit_sha) === (pullRequest.merge_commit_sha ?? null);
  }

  private mergeStoredPullRequest(stored: unknown, pullRequest: GitHubPullRequestDetails): Record<string, unknown> {
    return {
      ...this.readObject(stored),
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      state: pullRequest.state,
      is_draft: pullRequest.is_draft,
      base_ref: pullRequest.base_ref,
      head_ref: pullRequest.head_ref,
      merged_at: pullRequest.merged_at,
      merge_commit_sha: pullRequest.merge_commit_sha,
      synced_at: this.now(),
    };
  }

  private sameIssueSnapshot(stored: unknown, issue: GitHubIssueDetails): boolean {
    const snapshot = this.readObject(stored);
    return this.normalizeNullableString(snapshot.title) === issue.title
      && this.normalizeNullableString(snapshot.url) === issue.url
      && this.normalizeNullableString(snapshot.state) === issue.state
      && this.normalizeNullableString(snapshot.body_hash) === issue.body_hash
      && JSON.stringify(this.normalizeIssueLabels(this.readIssueLabels(snapshot.labels))) === JSON.stringify(this.normalizeIssueLabels(issue.labels))
      && JSON.stringify(this.normalizeIssueAssignees(this.readIssueAssignees(snapshot.assignees))) === JSON.stringify(this.normalizeIssueAssignees(issue.assignees));
  }

  private normalizeIssueLabels(labels: GitHubIssueLabel[]): GitHubIssueLabel[] {
    return [...labels]
      .map((label) => ({
        name: label.name,
        description: label.description,
        color: label.color,
      }))
      .sort((left, right) => `${left.name}|${left.color ?? ""}|${left.description ?? ""}`.localeCompare(`${right.name}|${right.color ?? ""}|${right.description ?? ""}`));
  }

  private normalizeIssueAssignees(assignees: GitHubIssueAssignee[]): GitHubIssueAssignee[] {
    return [...assignees]
      .map((assignee) => ({
        login: assignee.login,
        name: assignee.name,
      }))
      .sort((left, right) => `${left.login}|${left.name ?? ""}`.localeCompare(`${right.login}|${right.name ?? ""}`));
  }

  private readIssueLabels(value: unknown): GitHubIssueLabel[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        description: typeof item.description === "string" ? item.description : undefined,
        color: typeof item.color === "string" ? item.color : undefined,
      }))
      .filter((label) => Boolean(label.name));
  }

  private readIssueAssignees(value: unknown): GitHubIssueAssignee[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        login: typeof item.login === "string" ? item.login : "",
        name: typeof item.name === "string" ? item.name : undefined,
      }))
      .filter((assignee) => Boolean(assignee.login));
  }

  private readObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  private readNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private readBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
  }

  private normalizeNullableString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private toPullRequestDetails(repo: string, raw: RawPullRequestResponse): GitHubPullRequestDetails {
    return {
      repo,
      number: raw.number,
      url: raw.url,
      title: raw.title,
      body: raw.body ?? "",
      state: this.normalizePullRequestState(raw.state, raw.mergedAt ?? null),
      is_draft: Boolean(raw.isDraft),
      base_ref: raw.baseRefName?.trim() || "",
      head_ref: raw.headRefName?.trim() || "",
      merged_at: raw.mergedAt ?? null,
      merge_commit_sha: raw.mergeCommit?.oid ?? null,
    };
  }

  private normalizePullRequestState(state: string, mergedAt: string | null): "OPEN" | "CLOSED" | "MERGED" {
    if (mergedAt) return "MERGED";
    const normalized = state.trim().toUpperCase();
    if (normalized === "OPEN" || normalized === "CLOSED" || normalized === "MERGED") {
      return normalized;
    }
    return "OPEN";
  }

  private async runGhJson<T>(args: string[]): Promise<T> {
    const stdout = this.runGh(args);
    return JSON.parse(stdout) as T;
  }

  private runGh(args: string[], stdin?: string): string {
    try {
      return execFileSync("gh", args, {
        input: stdin,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 4,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`gh command failed: ${message}`);
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  private hash(value: string): string {
    return createHash("sha1").update(value).digest("hex");
  }

}
