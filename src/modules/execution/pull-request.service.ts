import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { EventBus } from "@nestjs/cqrs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultWorkingBranch } from "./default-working-branches.js";
import { WorkItemMergedEvent } from "./events/work-item-merged.event.js";
import { GitHubBatchCache } from "../github/github-batch-cache.service.js";
import { RunStore } from "./run-store.service.js";
import { ScratchpadService } from "./scratchpad.service.js";
import { WorktreeService } from "./worktree.service.js";
import { GitHubService } from "../github/github.service.js";
import { WorkItemHsmService } from "../graph/work-item-hsm.service.js";
import { WorkItemsService } from "../graph/work-items.service.js";
import type { WorkItemRecord } from "../graph/types.js";
import type {
  CreateExecutionPullRequestDto,
  CreateExecutionPullRequestResult,
  ExecutionPullRequestRecord,
  ExecutionRunRecord,
  SyncMergedExecutionDto,
  SyncMergedExecutionResult,
} from "./types.js";

/**
 * Phase 4e of the cqrs refactor (#234): final sub-service extracted
 * from ExecutionService. Owns pull request creation, merged-PR sync,
 * PR truth refresh, `autoStageAndCommit` (with ADR-014 step-6
 * scratchpad commit guards), PR title/body/commit-message builders,
 * and the merged-PR metadata composition.
 *
 * The HTTP entry points `createPullRequest` and `syncMergedPullRequest`
 * live here, but `ExecutionController` still routes through thin
 * wrappers on `ExecutionService` — matching the Phase 4b/4c/4d
 * cleanupWorktree / getRunChecklist / sendFollowUp passthrough pattern.
 *
 * `refreshRunsForPullRequest` is registered with `GitHubService` at
 * construction time. After Phase 4e, `ExecutionService` does not touch
 * `registerPullRequestTruthRefresher` at all.
 *
 * Injects seven siblings (all exported from ExecutionModule):
 *   - RunStore        — run record persistence, event emit, summary
 *   - WorktreeService  — runGitIn / runGhIn / listChangedFiles
 *   - ScratchpadService — step-6 commit guards
 *   - WorkItemsService  — work item lookup + meta/branch/actual_files
 *   - GitHubService     — PR read / findPullRequestForBranch / managed block sync
 *   - GitHubBatchCache  — merged-PR cache write-through
 *   - WorkItemHsmService — HSM state transitions on PR create + merged
 *
 * The `now()` + `getErrorMessage()` + `syncActualFiles()` helpers are
 * duplicated from ExecutionService per the Phase 3/4 trivial-helper
 * convention. `syncActualFiles` in particular stays on ExecutionService
 * too because executeRun still calls it; duplicating the 10-line body
 * is cheaper than forcing a cross-service call for a one-purpose helper.
 */
@Injectable()
export class PullRequestService {
  private readonly logger = new Logger(PullRequestService.name);

  constructor(
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(WorktreeService) private readonly worktreeService: WorktreeService,
    @Inject(ScratchpadService) private readonly scratchpadService: ScratchpadService,
    @Inject(WorkItemsService) private readonly workItemsService: WorkItemsService,
    @Inject(GitHubService) private readonly githubService: GitHubService,
    @Inject(GitHubBatchCache) private readonly githubBatchCache: GitHubBatchCache,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {
    // Phase 5 (#225): the bespoke `registerPullRequestTruthRefresher`
    // callback handshake is gone. `GitHubService.withPullRequestReconciliation`
    // now publishes a `PullRequestTruthRefreshedEvent`, and the
    // `PullRequestTruthRefreshedHandler` (registered in ExecutionModule)
    // delegates to `this.refreshRunsForPullRequest` via standard CQRS
    // event dispatch.
  }

  // ─── PR truth refresh (GitHubService callback) ───────────────────

  refreshRunsForPullRequest(
    pullRequest: {
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
    },
    options: { work_item_ids?: string[] } = {},
  ): { updated_run_ids: string[] } {
    const updatedRunIds: string[] = [];
    const workItemIds = new Set(options.work_item_ids ?? []);

    for (const run of this.runStore.listRecentRuns()) {
      const matchesByNumber = run.pull_request?.number === pullRequest.number;
      const matchesByBranch = run.branch === pullRequest.head_ref;
      const matchesByWorkItem = workItemIds.has(run.work_item_id);
      if (!matchesByNumber && !matchesByBranch && !matchesByWorkItem) {
        continue;
      }

      const nextPullRequest: ExecutionPullRequestRecord = {
        ...(run.pull_request ?? {}),
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        body: pullRequest.body,
        base_ref: pullRequest.base_ref,
        head_ref: pullRequest.head_ref,
        is_draft: pullRequest.is_draft,
        created_at: run.pull_request?.created_at ?? this.now(),
        state: pullRequest.state,
        merged_at: pullRequest.merged_at,
        merge_commit_sha: pullRequest.merge_commit_sha,
      };

      if (this.samePullRequestRecord(run.pull_request, nextPullRequest)) {
        continue;
      }

      const nextRun = this.runStore.updateRun(run.run_id, { pull_request: nextPullRequest });
      if (!nextRun) {
        continue;
      }

      this.runStore.appendEvent(nextRun, {
        type: "pull_request_truth_refreshed",
        pull_request: {
          number: nextPullRequest.number,
          state: nextPullRequest.state,
          merged_at: nextPullRequest.merged_at,
          merge_commit_sha: nextPullRequest.merge_commit_sha,
        },
      });
      this.runStore.writeSummary(nextRun);
      updatedRunIds.push(nextRun.run_id);
    }

    return { updated_run_ids: updatedRunIds };
  }

  // ─── createPullRequest ───────────────────────────────────────────

  async createPullRequest(input: CreateExecutionPullRequestDto): Promise<CreateExecutionPullRequestResult> {
    const runId = input.run_id?.trim();
    if (!runId) {
      throw new BadRequestException("run_id is required");
    }

    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new BadRequestException(`Unknown execution run: ${runId}`);
    }
    if (run.status !== "completed") {
      throw new BadRequestException(`Execution run ${runId} must be completed before creating a pull request`);
    }
    if (run.pull_request) {
      return { run, pull_request: run.pull_request };
    }

    const workItem = this.workItemsService.get(run.work_item_id);
    const baseRef = input.base_ref?.trim() || run.base_ref || getDefaultWorkingBranch(workItem.repo);

    // Auto-stage and commit if requested and worktree has uncommitted changes
    if (input.auto_commit !== false) {
      this.autoStageAndCommit(run, workItem, input.commit_message);
    }

    // ADR 014 step 6: hard guards at PR creation. These run even when
    // auto_commit: false (the auto-commit guard is inside an optional
    // branch) and they cover both the current staged state and the
    // branch's full committed history relative to the base ref.
    const prStagedViolations = this.scratchpadService.findStagedScratchpadViolations(run.worktree_path);
    if (prStagedViolations.length > 0) {
      this.runStore.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request",
        paths: prStagedViolations,
      });
      throw new BadRequestException(
        `pull_request_blocked_by_scratchpad: the following scratchpad files are staged and must not be committed before opening a pull request: ${prStagedViolations.join(", ")}. ` +
          `Unstage them (git reset HEAD -- <path>) before retrying.`,
      );
    }

    const committedViolations = this.scratchpadService.findCommittedScratchpadViolations(run.worktree_path, baseRef);
    if (committedViolations.length > 0) {
      this.runStore.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "pull_request_history",
        paths: committedViolations,
      });
      throw new BadRequestException(
        `pull_request_blocked_by_committed_scratchpad: the following scratchpad files were committed to branch ${run.branch}: ${committedViolations.join(", ")}. ` +
          `Inspect the history with \`git log ${baseRef}...HEAD -- '${committedViolations[0]}'\` and remove the files from the branch (e.g. \`git rm\` + rewrite) before opening a pull request.`,
      );
    }

    const title = input.title?.trim() || this.buildPullRequestTitle(workItem);
    const body = input.body?.trim() || this.buildPullRequestBody(run, workItem, baseRef);
    const aheadCount = this.worktreeService.countCommitsAhead(run.worktree_path, baseRef, run.branch);
    if (aheadCount === 0) {
      throw new BadRequestException(`Branch ${run.branch} has no commits ahead of ${baseRef}; nothing is ready to open as a pull request`);
    }

    this.worktreeService.runGitIn(run.worktree_path, ["push", "--set-upstream", "origin", run.branch]);
    this.worktreeService.runGhIn(run.worktree_path, [
      "pr",
      "create",
      "--base",
      baseRef,
      "--head",
      run.branch,
      "--title",
      title,
      "--body-file",
      "-",
      ...(input.draft ? ["--draft"] : []),
    ], body);

    const pullRequest = this.readPullRequest(run.worktree_path, title, body);
    const nextRun = this.runStore.updateRun(run.run_id, { pull_request: pullRequest }) ?? run;
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "outputs", "pull-request.json"), JSON.stringify(pullRequest, null, 2), "utf8");
    this.runStore.appendEvent(nextRun, { type: "pull_request_created", pull_request: pullRequest });
    this.runStore.writeSummary(nextRun);

    // Update work item: dispatch HSM event for state transition, then
    // write non-state fields (branch, meta.pull_request) separately.
    try {
      const prPayload = {
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        is_draft: pullRequest.is_draft,
        head_ref: pullRequest.head_ref,
        base_ref: pullRequest.base_ref,
        created_at: pullRequest.created_at,
      };
      await this.hsmService.dispatch(run.work_item_id, {
        type: "gh.pr_opened",
        pull_request: prPayload,
      });
      // studio-197: write-through to batch cache so next reconcile sees the PR.
      if (workItem.repo) {
        this.githubBatchCache.upsertPullRequest(workItem.repo, {
          number: pullRequest.number,
          state: "OPEN",
          merged_at: null,
          head_ref: pullRequest.head_ref,
          base_ref: pullRequest.base_ref,
          url: pullRequest.url,
          title: pullRequest.title,
          is_draft: pullRequest.is_draft ?? false,
        });
      }
      // Write additional meta fields that the HSM doesn't manage.
      // Branch is now set by the HSM's stampMeta:studio_open_pr_sync action.
      const existingMeta = this.workItemsService.get(run.work_item_id).meta ?? {};
      this.workItemsService.update(run.work_item_id, {
        meta: {
          ...existingMeta,
          pull_request: prPayload,
        },
      });
    } catch (updateError) {
      this.logger.warn(`Failed to update work item ${run.work_item_id} after PR creation: ${this.getErrorMessage(updateError)}`);
    }

    return { run: nextRun, pull_request: pullRequest };
  }

  // ─── syncMergedPullRequest ───────────────────────────────────────

  /**
   * Phase 4e (#234): post-merge sync. Returns the envelope **without**
   * `dispatch_preview` — the thin wrapper on `ExecutionService` adds
   * the dispatch preview via its own `getPreview` helper so
   * PullRequestService stays free of a GraphService injection (and
   * free of an ExecutionService back-reference).
   */
  async syncMergedPullRequest(
    input: SyncMergedExecutionDto,
  ): Promise<Omit<SyncMergedExecutionResult, "dispatch_preview">> {
    const workItemId = input.work_item_id?.trim();
    if (!workItemId) {
      throw new BadRequestException("work_item_id is required");
    }

    const workItem = this.workItemsService.get(workItemId);
    if (!workItem.repo) {
      throw new BadRequestException(`Work item ${workItemId} is missing repo metadata required for PR sync`);
    }

    const pullRequest = input.pull_request_number
      ? await this.githubService.readPullRequest(workItem.repo, input.pull_request_number)
      : await this.resolvePullRequestFromWorkItem(workItem);

    if (!pullRequest.merged_at) {
      throw new BadRequestException(`Pull request #${pullRequest.number} has not been merged yet`);
    }

    const matchedRun = this.findRecentRunForSync(workItem, pullRequest.number);
    const actualFilesSelection = this.selectActualFilesForMergeSync(input, workItem, matchedRun);
    const nextBranch = this.normalizeNullableString(input.branch) ?? workItem.branch ?? (pullRequest.head_ref || null);
    const nextArchivePath = this.hasOwn(input, "archive_path") ? (input.archive_path ?? null) : workItem.archive_path;
    const nextMeta = this.buildMergedWorkItemMeta(workItem, pullRequest, matchedRun?.run_id ?? null, actualFilesSelection.source);

    // ADR 014 step 3: post-merge sync lands on 'merged_pr', not 'done'.
    // 'merged_pr' is a stable resting state that the disposition flow
    // (ADR 014 step 7) will transition to 'done' after archival completes.
    // HSM handles the state transition; non-state fields follow separately.
    await this.hsmService.dispatch(workItem.id, {
      type: "gh.pr_merged",
      pull_request: {
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        head_ref: pullRequest.head_ref,
        base_ref: pullRequest.base_ref,
        merged_at: pullRequest.merged_at,
      },
    });
    // studio-197: write-through to batch cache so next reconcile sees MERGED.
    this.githubBatchCache.upsertPullRequest(workItem.repo, {
      number: pullRequest.number,
      state: "MERGED",
      merged_at: pullRequest.merged_at,
      head_ref: pullRequest.head_ref,
      base_ref: pullRequest.base_ref,
      url: pullRequest.url,
      title: pullRequest.title,
      is_draft: false,
    });
    this.workItemsService.update(workItem.id, {
      actual_files: actualFilesSelection.files,
      branch: nextBranch,
      archive_path: nextArchivePath,
      meta: nextMeta,
    });

    // Phase 5 (#225): publish WorkItemMergedEvent after the HSM
    // dispatch + work-item update have both committed. No subscribers
    // land in this phase; the event exists for future consumers.
    this.eventBus.publish(
      new WorkItemMergedEvent(
        workItem.id,
        {
          number: pullRequest.number,
          url: pullRequest.url,
          title: pullRequest.title,
          merged_at: pullRequest.merged_at!,
          merge_commit_sha: pullRequest.merge_commit_sha ?? null,
        },
        "sync_merged_api",
      ),
    );

    const updatedWorkItem = this.workItemsService.get(workItem.id);
    const managedBlockSync = input.stage_github_sync ? await this.safeStageManagedBlockSync(updatedWorkItem.id) : undefined;

    if (matchedRun) {
      const nextPullRequest: ExecutionPullRequestRecord = {
        ...(matchedRun.pull_request ?? this.toExecutionPullRequestRecord(pullRequest)),
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        body: pullRequest.body,
        base_ref: pullRequest.base_ref,
        head_ref: pullRequest.head_ref,
        is_draft: pullRequest.is_draft,
        state: pullRequest.state,
        merged_at: pullRequest.merged_at,
        merge_commit_sha: pullRequest.merge_commit_sha,
      };
      const syncedRun = this.runStore.updateRun(matchedRun.run_id, { pull_request: nextPullRequest }) ?? matchedRun;
      this.runStore.appendEvent(syncedRun, {
        type: "post_merge_sync_completed",
        work_item_id: updatedWorkItem.id,
        pull_request: nextPullRequest,
        actual_files: actualFilesSelection.files,
      });
      this.runStore.writeSummary(syncedRun);
    }

    return {
      synced: true,
      work_item: {
        id: updatedWorkItem.id,
        state: updatedWorkItem.state,
        branch: updatedWorkItem.branch,
        archive_path: updatedWorkItem.archive_path,
        actual_files: updatedWorkItem.actual_files,
        meta: updatedWorkItem.meta,
        updated_at: updatedWorkItem.updated_at,
      },
      pull_request: this.toExecutionPullRequestRecord(pullRequest),
      matched_run_id: matchedRun?.run_id ?? null,
      actual_files_source: actualFilesSelection.source,
      managed_block_sync: managedBlockSync,
      cleanup: matchedRun ? this.worktreeService.safeCleanupRun(matchedRun) : null,
    };
  }

  // ─── Internal PR helpers ─────────────────────────────────────────

  private readPullRequest(worktreePath: string, fallbackTitle: string, body: string): ExecutionPullRequestRecord {
    const raw = this.worktreeService.runGhIn(worktreePath, ["pr", "view", "--json", "number,url,title,body,baseRefName,headRefName,isDraft"]);
    const parsed = JSON.parse(raw) as {
      number?: number;
      url?: string;
      title?: string;
      body?: string;
      baseRefName?: string;
      headRefName?: string;
      isDraft?: boolean;
    };

    if (!Number.isInteger(parsed.number) || !parsed.url || !parsed.baseRefName || !parsed.headRefName) {
      throw new BadRequestException("Created pull request could not be read back from GitHub safely");
    }

    return {
      number: parsed.number!,
      url: parsed.url,
      title: parsed.title?.trim() || fallbackTitle,
      body: parsed.body ?? body,
      base_ref: parsed.baseRefName!,
      head_ref: parsed.headRefName!,
      is_draft: Boolean(parsed.isDraft),
      created_at: this.now(),
    };
  }

  private buildPullRequestTitle(workItem: WorkItemRecord): string {
    const issuePrefix = workItem.issue_number ? `[#${workItem.issue_number}] ` : "";
    return `${issuePrefix}${workItem.name}`;
  }

  private buildPullRequestBody(run: ExecutionRunRecord, workItem: WorkItemRecord, baseRef: string): string {
    const lines = [
      "## Summary",
      run.result_summary ?? run.progress_message ?? `Completed Studio execution run ${run.run_id}.`,
      "",
      "## Context",
      `- Work item: ${workItem.id}`,
      `- Issue: ${workItem.issue_url ?? "(not linked)"}`,
      `- Base branch: ${baseRef}`,
      `- Head branch: ${run.branch}`,
      `- Artifact dir: ${run.artifact_dir}`,
      `- Worktree: ${run.worktree_path}`,
    ];

    if (workItem.scope_hint) {
      lines.push(`- Scope hint: ${workItem.scope_hint}`);
    }

    lines.push("", "## Changed files");
    if (run.changed_files?.length) {
      lines.push(...run.changed_files.map((path) => `- \`${path}\``));
    } else {
      lines.push("- (not recorded)");
    }

    return lines.join("\n");
  }

  private autoStageAndCommit(run: ExecutionRunRecord, workItem: WorkItemRecord, commitMessage?: string): void {
    const status = this.worktreeService.runGitIn(run.worktree_path, ["status", "--porcelain"], { allowFailure: true }).trim();
    if (!status) {
      return; // working tree is clean, nothing to commit
    }

    this.logger.log(`Auto-staging and committing changes in ${run.worktree_path}`);
    this.worktreeService.runGitIn(run.worktree_path, ["add", "-A"]);

    // ADR 014 step 6: hard guard against committing `SCRATCHPAD_*.md`.
    // Replaces the silent `.gitignore` trick — disobedience is now visible.
    const stagedViolations = this.scratchpadService.findStagedScratchpadViolations(run.worktree_path);
    if (stagedViolations.length > 0) {
      this.runStore.appendEvent(run, {
        type: "scratchpad_commit_blocked",
        phase: "auto_commit",
        paths: stagedViolations,
      });
      throw new BadRequestException(
        `auto_commit_blocked_by_scratchpad: the following scratchpad files are staged and must not be committed: ${stagedViolations.join(", ")}. ` +
          `Unstage them (git reset HEAD -- <path>) and retry. The canonical scratchpad lives at plans/<slug>/ and should not enter the worktree's git history.`,
      );
    }

    const message = commitMessage?.trim() || this.buildCommitMessage(workItem);
    this.worktreeService.runGitIn(run.worktree_path, ["commit", "-m", message]);

    // Refresh changed files after commit
    const changedFiles = this.worktreeService.listChangedFiles(run.worktree_path);
    if (changedFiles.length > 0) {
      this.runStore.updateRun(run.run_id, { changed_files: changedFiles });
    }
  }

  private buildCommitMessage(workItem: WorkItemRecord): string {
    const issueRef = workItem.issue_number ? ` (#${workItem.issue_number})` : "";
    return `${workItem.name}${issueRef}`;
  }

  private async resolvePullRequestFromWorkItem(workItem: WorkItemRecord) {
    const branch = workItem.branch?.trim();
    if (!branch) {
      throw new BadRequestException(`Work item ${workItem.id} is missing branch metadata required to resolve its pull request`);
    }

    const pullRequest = await this.githubService.findPullRequestForBranch(workItem.repo ?? "", branch);
    if (!pullRequest) {
      throw new BadRequestException(`No pull request was found for branch ${branch}`);
    }

    return pullRequest;
  }

  private findRecentRunForSync(workItem: WorkItemRecord, pullRequestNumber: number): ExecutionRunRecord | null {
    return this.runStore.listRecentRuns().find((run) => {
      if (run.work_item_id !== workItem.id) {
        return false;
      }
      if (run.pull_request?.number === pullRequestNumber) {
        return true;
      }
      return run.branch === workItem.branch;
    }) ?? null;
  }

  private selectActualFilesForMergeSync(
    input: SyncMergedExecutionDto,
    workItem: WorkItemRecord,
    matchedRun: ExecutionRunRecord | null,
  ): { files: string[]; source: "input" | "work_item" | "run" } {
    if (Array.isArray(input.actual_files) && input.actual_files.length > 0) {
      return { files: this.uniqueSorted(input.actual_files), source: "input" };
    }
    if (workItem.actual_files.length > 0) {
      return { files: this.uniqueSorted(workItem.actual_files), source: "work_item" };
    }
    if (matchedRun?.changed_files?.length) {
      return { files: this.uniqueSorted(matchedRun.changed_files), source: "run" };
    }
    return { files: [], source: "work_item" };
  }

  private buildMergedWorkItemMeta(
    workItem: WorkItemRecord,
    pullRequest: {
      number: number;
      url: string;
      title: string;
      state: string;
      base_ref: string;
      head_ref: string;
      merged_at: string | null;
      merge_commit_sha: string | null;
    },
    runId: string | null,
    actualFilesSource: "input" | "work_item" | "run",
  ): Record<string, unknown> {
    return {
      ...workItem.meta,
      studio_post_merge_sync: {
        synced_at: this.now(),
        run_id: runId,
        actual_files_source: actualFilesSource,
        pull_request: {
          number: pullRequest.number,
          url: pullRequest.url,
          title: pullRequest.title,
          state: pullRequest.state,
          base_ref: pullRequest.base_ref,
          head_ref: pullRequest.head_ref,
          merged_at: pullRequest.merged_at,
          merge_commit_sha: pullRequest.merge_commit_sha,
        },
      },
    };
  }

  private async safeStageManagedBlockSync(workItemId: string) {
    try {
      const staged = await this.githubService.stageManagedBlockSync(workItemId);
      return {
        work_item_id: staged.work_item_id,
        based_on_body_hash: staged.based_on_body_hash,
        operations: staged.operations,
      };
    } catch (error) {
      this.logger.warn(`Failed to stage managed block sync for ${workItemId}: ${this.getErrorMessage(error)}`);
      return null;
    }
  }

  private toExecutionPullRequestRecord(pullRequest: {
    number: number;
    url: string;
    title: string;
    body: string;
    base_ref: string;
    head_ref: string;
    is_draft: boolean;
    state: string;
    merged_at: string | null;
    merge_commit_sha: string | null;
  }): ExecutionPullRequestRecord {
    return {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      body: pullRequest.body,
      base_ref: pullRequest.base_ref,
      head_ref: pullRequest.head_ref,
      is_draft: pullRequest.is_draft,
      created_at: this.now(),
      state: pullRequest.state,
      merged_at: pullRequest.merged_at,
      merge_commit_sha: pullRequest.merge_commit_sha,
    };
  }

  private samePullRequestRecord(left: ExecutionPullRequestRecord | undefined, right: ExecutionPullRequestRecord): boolean {
    if (!left) {
      return false;
    }

    return left.number === right.number
      && left.url === right.url
      && left.title === right.title
      && left.body === right.body
      && left.base_ref === right.base_ref
      && left.head_ref === right.head_ref
      && left.is_draft === right.is_draft
      && left.state === right.state
      && (left.merged_at ?? null) === (right.merged_at ?? null)
      && (left.merge_commit_sha ?? null) === (right.merge_commit_sha ?? null);
  }

  // ─── Trivial helpers (duplicated from ExecutionService) ──────────

  private normalizeNullableString(value?: string | null): string | null | undefined {
    if (typeof value === "undefined") {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  private uniqueSorted(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
