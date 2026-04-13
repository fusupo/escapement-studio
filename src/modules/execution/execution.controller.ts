import { Body, Controller, Get, Inject, Param, Post, Query, Sse } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Observable } from "rxjs";
import { ArchiveAndCloseMergedPullRequestCommand } from "./application/commands/archive-and-close-merged-pull-request.command.js";
import { CancelWorkItemCommand } from "./application/commands/cancel-work-item.command.js";
import { CloseMergedPullRequestCommand } from "./application/commands/close-merged-pull-request.command.js";
import { DeleteWorkItemCommand } from "./application/commands/delete-work-item.command.js";
import { TransitionInProgressToDraftingCommand } from "./application/commands/transition-in-progress-to-drafting.command.js";
import { TransitionInProgressToReadyCommand } from "./application/commands/transition-in-progress-to-ready.command.js";
import { ExecutionService } from "./execution.service.js";
import { RunStore } from "./run-store.service.js";
import type {
  ArchiveAndCloseMergedPullRequestResult,
  CancelWorkItemDto,
  CancelWorkItemResult,
  CleanupWorktreeDto,
  CloseMergedPullRequestResult,
  CreateExecutionPullRequestDto,
  DeleteWorkItemDto,
  DeleteWorkItemResult,
  FollowUpMessageDto,
  LaunchExecutionRunDto,
  ResolveDisambiguationDto,
  SyncMergedExecutionDto,
  TransitionWorkItemDto,
} from "./types.js";
import type { WorkItemRecord } from "../graph/types.js";

@Controller("api/execution")
export class ExecutionController {
  constructor(
    @Inject(ExecutionService) private readonly executionService: ExecutionService,
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(CommandBus) private readonly commandBus: CommandBus,
  ) {}

  @Get("preview")
  getPreview(@Query("repo") repo?: string) {
    return this.executionService.getPreview(repo);
  }

  @Get("runs")
  getRecentRuns() {
    return this.runStore.listRecentRuns();
  }

  @Get("archived-runs")
  getArchivedRunBundles() {
    return this.executionService.listArchivedRunBundles();
  }

  @Get("archived-runs/:workItemId")
  getArchivedRunBundle(@Param("workItemId") workItemId: string) {
    return this.executionService.getArchivedRunBundle(workItemId);
  }

  @Get("eligibility")
  getLaunchEligibility(@Query("work_item_id") workItemId?: string, @Query("base_ref") baseRef?: string) {
    return this.executionService.getLaunchEligibility(workItemId, baseRef);
  }

  @Get("runs/:runId/activity")
  getRunActivity(@Param("runId") runId: string) {
    return this.executionService.getRunActivityLog(runId);
  }

  @Post("launch")
  launch(@Body() body: LaunchExecutionRunDto) {
    return this.executionService.launch(body);
  }

  @Post("pull-request")
  createPullRequest(@Body() body: CreateExecutionPullRequestDto) {
    return this.executionService.createPullRequest(body);
  }

  @Post("post-merge-sync")
  syncMergedPullRequest(@Body() body: SyncMergedExecutionDto) {
    return this.executionService.syncMergedPullRequest(body);
  }

  @Post("cleanup")
  cleanupWorktree(@Body() body: CleanupWorktreeDto) {
    return this.executionService.cleanupWorktree(body);
  }

  @Post("cleanup-all")
  cleanupAllStale() {
    return this.executionService.cleanupAllStale();
  }

  @Post("follow-up")
  sendFollowUp(@Body() body: FollowUpMessageDto) {
    return this.executionService.sendFollowUp(body);
  }

  @Post("resolve-disambiguation")
  resolveDisambiguation(@Body() body: ResolveDisambiguationDto) {
    return this.executionService.resolveDisambiguation(body);
  }

  @Post("transition-ready")
  transitionInProgressToReady(@Body() body: TransitionWorkItemDto): Promise<WorkItemRecord> {
    return this.commandBus.execute<TransitionInProgressToReadyCommand, WorkItemRecord>(
      new TransitionInProgressToReadyCommand(body.work_item_id),
    );
  }

  @Post("transition-drafting")
  transitionInProgressToDrafting(@Body() body: TransitionWorkItemDto): Promise<WorkItemRecord> {
    return this.commandBus.execute<TransitionInProgressToDraftingCommand, WorkItemRecord>(
      new TransitionInProgressToDraftingCommand(body.work_item_id),
    );
  }

  @Post("close-merged")
  closeMergedPullRequest(@Body() body: TransitionWorkItemDto): Promise<CloseMergedPullRequestResult> {
    return this.commandBus.execute<CloseMergedPullRequestCommand, CloseMergedPullRequestResult>(
      new CloseMergedPullRequestCommand(body.work_item_id),
    );
  }

  @Post("archive-and-close-merged")
  archiveAndCloseMergedPullRequest(
    @Body() body: TransitionWorkItemDto,
  ): Promise<ArchiveAndCloseMergedPullRequestResult> {
    return this.commandBus.execute<
      ArchiveAndCloseMergedPullRequestCommand,
      ArchiveAndCloseMergedPullRequestResult
    >(new ArchiveAndCloseMergedPullRequestCommand(body.work_item_id));
  }

  @Post("cancel-work-item")
  cancelWorkItem(@Body() body: CancelWorkItemDto): Promise<CancelWorkItemResult> {
    return this.commandBus.execute<CancelWorkItemCommand, CancelWorkItemResult>(
      new CancelWorkItemCommand(body),
    );
  }

  @Post("delete-work-item")
  deleteWorkItem(@Body() body: DeleteWorkItemDto): Promise<DeleteWorkItemResult> {
    return this.commandBus.execute<DeleteWorkItemCommand, DeleteWorkItemResult>(
      new DeleteWorkItemCommand(body),
    );
  }

  @Get("runs/:runId/chat")
  getRunChat(@Param("runId") runId: string) {
    return this.executionService.getRunChatHistory(runId);
  }

  @Get("runs/:runId/checklist")
  getRunChecklist(@Param("runId") runId: string) {
    return this.executionService.getRunChecklist(runId);
  }

  @Get("runs/:runId/scratchpad")
  getRunScratchpad(@Param("runId") runId: string) {
    return this.executionService.getRunScratchpad(runId);
  }

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.runStore.stream();
  }
}
