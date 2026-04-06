import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { SQLiteService } from "../graph/sqlite.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type {
  GitHubIssueDetails,
  GitHubIssueAssignee,
  GitHubIssueLabel,
  GitHubSyncApplyResult,
  GitHubSyncOperation,
  GitHubSyncProposal,
} from "../planning/types.js";

const START_MARKER = "<!-- studio-sync:start -->";
const END_MARKER = "<!-- studio-sync:end -->";

interface RawIssueResponse {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels?: Array<{ name?: string; description?: string; color?: string }>;
  assignees?: Array<{ login?: string; name?: string }>;
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
}

@Injectable()
export class GitHubService {
  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
  ) {}

  private get db(): DatabaseType {
    return this.sqlite.getDb();
  }

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

  async closeIssue(repo: string, issueNumber: number): Promise<GitHubIssueDetails> {
    if (!repo?.trim()) {
      throw new BadRequestException("repo is required");
    }
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new BadRequestException("issue_number must be a positive integer");
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
    const managedBlock = this.extractManagedBlock(body);

    return {
      repo,
      number: raw.number,
      title: raw.title,
      body,
      url: raw.url,
      state: raw.state,
      labels: (raw.labels ?? []).map((label): GitHubIssueLabel => ({
        name: label.name ?? "",
        description: label.description,
        color: label.color,
      })).filter((label) => Boolean(label.name)),
      assignees: (raw.assignees ?? []).map((assignee): GitHubIssueAssignee => ({
        login: assignee.login ?? "",
        name: assignee.name,
      })).filter((assignee) => Boolean(assignee.login)),
      body_hash: this.hash(body),
      managed_block: managedBlock,
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

    return this.toPullRequestDetails(repo, raw);
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

    return exactMatches[0] ?? null;
  }

  async stageManagedBlockSync(workItemId: string) {
    const workItem = this.workItems.get(workItemId);
    if (!workItem.repo || !workItem.issue_number || !workItem.issue_url) {
      throw new BadRequestException(`Work item ${workItemId} is not linked to a GitHub issue`);
    }

    const issue = await this.readIssue(workItem.repo, workItem.issue_number);
    const replacement = this.replaceManagedBlock(issue.body, this.renderManagedBlock(workItemId));

    if (!replacement.ok) {
      throw new BadRequestException(replacement.message);
    }

    const operation: GitHubSyncOperation = {
      id: "op1",
      kind: "update_managed_body_block",
      summary: `Update managed Studio planning block for issue #${issue.number}`,
      rationale: `Sync planning metadata from Studio work item ${workItemId} into the machine-managed issue body block.`,
      target: {
        repo: workItem.repo,
        issue_number: workItem.issue_number,
        work_item_id: workItemId,
      },
      preview: {
        before: replacement.currentBlock,
        after: replacement.nextBlock,
      },
    };

    return {
      issue,
      work_item_id: workItemId,
      based_on_body_hash: issue.body_hash,
      operations: [operation],
    };
  }

  async applySyncProposal(proposal: GitHubSyncProposal, approvedOperationIds: string[]): Promise<{ result: GitHubSyncApplyResult; issue: GitHubIssueDetails | null }> {
    const uniqueIds = Array.from(new Set(approvedOperationIds));
    const operations = uniqueIds.map((id) => {
      const operation = proposal.operations.find((candidate) => candidate.id === id);
      if (!operation) {
        throw new BadRequestException(`Unknown GitHub sync operation id: ${id}`);
      }
      return operation;
    });

    if (operations.length === 0) {
      throw new BadRequestException("approved_operation_ids must contain at least one operation id");
    }

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

    const errors: Array<{ operation_id: string; message: string }> = [];
    let nextBody = issue.body;

    for (const operation of operations) {
      if (operation.kind !== "update_managed_body_block") {
        errors.push({ operation_id: operation.id, message: `Unsupported GitHub sync operation kind: ${operation.kind}` });
        continue;
      }

      const replacement = this.replaceManagedBlock(nextBody, operation.preview.after);
      if (!replacement.ok) {
        errors.push({ operation_id: operation.id, message: replacement.message });
        continue;
      }
      nextBody = replacement.body;
    }

    if (errors.length > 0) {
      return {
        result: {
          status: "validation_failed",
          errors,
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
    ], nextBody);

    const updatedIssue = await this.readIssue(proposal.issue.repo, proposal.issue.issue_number);
    return {
      result: {
        status: "applied",
        applied_operation_ids: uniqueIds,
        previous_body_hash: issue.body_hash,
        new_body_hash: updatedIssue.body_hash,
      },
      issue: updatedIssue,
    };
  }

  private renderManagedBlock(workItemId: string): string {
    const workItem = this.workItems.get(workItemId);
    const dependsOn = this.listRelatedIds(workItemId, "depends_on", "to_id");
    const partOf = this.listRelatedIds(workItemId, "is_part_of", "to_id");
    const predictedFiles = workItem.predicted_files ?? [];

    const lines = [
      START_MARKER,
      "## Studio Planning Metadata",
      `- State: ${workItem.state}`,
    ];

    if (workItem.scope_hint) {
      lines.push(`- Scope hint: ${workItem.scope_hint}`);
    }

    lines.push("- Predicted files:");
    if (predictedFiles.length === 0) {
      lines.push("  - (none)");
    } else {
      for (const file of predictedFiles) {
        lines.push(`  - \`${file}\``);
      }
    }

    lines.push("- Depends on:");
    if (dependsOn.length === 0) {
      lines.push("  - (none)");
    } else {
      for (const id of dependsOn) {
        lines.push(`  - ${id}`);
      }
    }

    lines.push("- Part of:");
    if (partOf.length === 0) {
      lines.push("  - (none)");
    } else {
      for (const id of partOf) {
        lines.push(`  - ${id}`);
      }
    }

    lines.push(END_MARKER);
    return lines.join("\n");
  }

  private listRelatedIds(workItemId: string, rel: string, column: "to_id" | "from_id"): string[] {
    const rows = this.db
      .prepare(`SELECT ${column} FROM edges WHERE ${column === "to_id" ? "from_id" : "to_id"} = ? AND rel = ? ORDER BY ${column}`)
      .all(workItemId, rel) as Array<{ to_id?: string; from_id?: string }>;

    return rows
      .map((row) => row[column])
      .filter((value): value is string => typeof value === "string");
  }

  private extractManagedBlock(body: string) {
    const matches = [...body.matchAll(new RegExp(`${this.escapeRegExp(START_MARKER)}[\\s\\S]*?${this.escapeRegExp(END_MARKER)}`, "g"))];
    if (matches.length === 0) {
      return null;
    }
    if (matches.length > 1) {
      throw new BadRequestException("GitHub issue body has multiple studio-sync blocks and cannot be updated safely");
    }

    return {
      content: matches[0][0],
      start_marker: START_MARKER,
      end_marker: END_MARKER,
    };
  }

  private replaceManagedBlock(body: string, nextBlock: string): { ok: true; body: string; currentBlock: string; nextBlock: string } | { ok: false; message: string } {
    const matches = [...body.matchAll(new RegExp(`${this.escapeRegExp(START_MARKER)}[\\s\\S]*?${this.escapeRegExp(END_MARKER)}`, "g"))];
    if (matches.length === 0) {
      return { ok: false, message: "GitHub issue body is missing the managed studio-sync block and cannot be synced safely." };
    }
    if (matches.length > 1) {
      return { ok: false, message: "GitHub issue body has multiple managed studio-sync blocks and cannot be synced safely." };
    }

    const currentBlock = matches[0][0];
    return {
      ok: true,
      body: body.replace(currentBlock, nextBlock),
      currentBlock,
      nextBlock,
    };
  }

  private toPullRequestDetails(repo: string, raw: RawPullRequestResponse): GitHubPullRequestDetails {
    return {
      repo,
      number: raw.number,
      url: raw.url,
      title: raw.title,
      body: raw.body ?? "",
      state: raw.state,
      is_draft: Boolean(raw.isDraft),
      base_ref: raw.baseRefName?.trim() || "",
      head_ref: raw.headRefName?.trim() || "",
      merged_at: raw.mergedAt ?? null,
      merge_commit_sha: raw.mergeCommit?.oid ?? null,
    };
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

  private hash(value: string): string {
    return createHash("sha1").update(value).digest("hex");
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
