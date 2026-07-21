import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Database as DatabaseType } from "better-sqlite3";
import { SQLiteService } from "../../platform/sqlite.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { GitHubIssueDetails, GitHubSyncOperation, GitHubSyncProposal } from "../planning/types.js";

const START_MARKER = "<!-- studio-sync:start -->";
const END_MARKER = "<!-- studio-sync:end -->";

@Injectable()
export class GitHubIssueBodySyncService {
  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
  ) {}

  private get db(): DatabaseType {
    return this.sqlite.getDb();
  }

  async stageManagedBlockSync(
    workItemId: string,
    readIssue: (repo: string, issueNumber: number) => Promise<GitHubIssueDetails>,
  ) {
    const workItem = this.workItems.get(workItemId);
    if (!workItem.repo || !workItem.issue_number || !workItem.issue_url) {
      throw new BadRequestException(`Work item ${workItemId} is not linked to a GitHub issue`);
    }

    const issue = await readIssue(workItem.repo, workItem.issue_number);
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
        unified_diff: this.buildUnifiedDiff(replacement.currentBlock, replacement.nextBlock, "managed-block.before", "managed-block.after"),
      },
    };

    return {
      issue,
      work_item_id: workItemId,
      based_on_body_hash: issue.body_hash,
      operations: [operation],
    };
  }

  async stageIssueBodySync(
    workItemId: string,
    bodyAfter: string,
    readIssue: (repo: string, issueNumber: number) => Promise<GitHubIssueDetails>,
  ) {
    const workItem = this.workItems.get(workItemId);
    if (!workItem.repo || !workItem.issue_number || !workItem.issue_url) {
      throw new BadRequestException(`Work item ${workItemId} is not linked to a GitHub issue`);
    }

    const issue = await readIssue(workItem.repo, workItem.issue_number);
    this.assertManagedBlockPreserved(issue.body, bodyAfter);

    const operation: GitHubSyncOperation = {
      id: "op1",
      kind: "replace_issue_body",
      summary: `Replace issue body for issue #${issue.number}`,
      rationale: `Apply the reviewed issue body clarification for Studio work item ${workItemId}.`,
      target: {
        repo: workItem.repo,
        issue_number: workItem.issue_number,
        work_item_id: workItemId,
      },
      preview: {
        before: issue.body,
        after: bodyAfter,
        unified_diff: this.buildUnifiedDiff(issue.body, bodyAfter, "issue.before", "issue.after"),
      },
    };

    return {
      issue,
      work_item_id: workItemId,
      based_on_body_hash: issue.body_hash,
      operations: [operation],
    };
  }

  buildApprovedBody(
    issue: GitHubIssueDetails,
    proposal: GitHubSyncProposal,
    approvedOperationIds: string[],
  ): { ok: true; body: string; applied_operation_ids: string[] } | { ok: false; errors: Array<{ operation_id: string; message: string }> } {
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

    const errors: Array<{ operation_id: string; message: string }> = [];
    let nextBody = issue.body;

    for (const operation of operations) {
      if (operation.kind === "update_managed_body_block") {
        const replacement = this.replaceManagedBlock(nextBody, operation.preview.after);
        if (!replacement.ok) {
          errors.push({ operation_id: operation.id, message: replacement.message });
          continue;
        }
        if (replacement.currentBlock !== operation.preview.before) {
          errors.push({ operation_id: operation.id, message: "Managed block content no longer matches the reviewed preview." });
          continue;
        }
        nextBody = replacement.body;
        continue;
      }

      if (operation.kind === "replace_issue_body") {
        if (nextBody !== operation.preview.before) {
          errors.push({ operation_id: operation.id, message: "Issue body no longer matches the reviewed preview." });
          continue;
        }
        try {
          this.assertManagedBlockPreserved(nextBody, operation.preview.after);
        } catch (error) {
          errors.push({ operation_id: operation.id, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        nextBody = operation.preview.after;
        continue;
      }

      errors.push({ operation_id: operation.id, message: `Unsupported GitHub sync operation kind: ${operation.kind}` });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      body: nextBody,
      applied_operation_ids: uniqueIds,
    };
  }

  extractManagedBlock(body: string) {
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

  private assertManagedBlockPreserved(bodyBefore: string, bodyAfter: string): void {
    const beforeBlock = this.extractManagedBlock(bodyBefore);
    const afterBlock = this.extractManagedBlock(bodyAfter);

    if (!beforeBlock && !afterBlock) {
      return;
    }
    if (!beforeBlock && afterBlock) {
      throw new BadRequestException("Broader issue body edits must not introduce a managed studio-sync block.");
    }
    if (beforeBlock && !afterBlock) {
      throw new BadRequestException("Broader issue body edits must preserve the existing managed studio-sync block unchanged.");
    }
    if (beforeBlock?.content !== afterBlock?.content) {
      throw new BadRequestException("Broader issue body edits must preserve the existing managed studio-sync block unchanged.");
    }
  }

  private buildUnifiedDiff(before: string, after: string, beforeLabel: string, afterLabel: string): string {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const table = Array.from({ length: beforeLines.length + 1 }, () => Array<number>(afterLines.length + 1).fill(0));

    for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
      for (let right = afterLines.length - 1; right >= 0; right -= 1) {
        table[left][right] = beforeLines[left] === afterLines[right]
          ? table[left + 1][right + 1] + 1
          : Math.max(table[left + 1][right], table[left][right + 1]);
      }
    }

    const diffLines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`, `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`];
    let left = 0;
    let right = 0;

    while (left < beforeLines.length && right < afterLines.length) {
      if (beforeLines[left] === afterLines[right]) {
        diffLines.push(` ${beforeLines[left]}`);
        left += 1;
        right += 1;
        continue;
      }

      if (table[left + 1][right] >= table[left][right + 1]) {
        diffLines.push(`-${beforeLines[left]}`);
        left += 1;
      } else {
        diffLines.push(`+${afterLines[right]}`);
        right += 1;
      }
    }

    while (left < beforeLines.length) {
      diffLines.push(`-${beforeLines[left]}`);
      left += 1;
    }

    while (right < afterLines.length) {
      diffLines.push(`+${afterLines[right]}`);
      right += 1;
    }

    return diffLines.join("\n");
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
