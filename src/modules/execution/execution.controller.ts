import { Body, Controller, Get, Inject, Param, Post, Query, Sse } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { ExecutionService } from "./execution.service.js";
import type { CleanupWorktreeDto, CreateExecutionPullRequestDto, FollowUpMessageDto, LaunchExecutionRunDto, ResolveDisambiguationDto, SyncMergedExecutionDto, TransitionWorkItemDto } from "./types.js";

@Controller("api/execution")
export class ExecutionController {
  constructor(@Inject(ExecutionService) private readonly executionService: ExecutionService) {}

  @Get("preview")
  getPreview(@Query("repo") repo?: string) {
    return this.executionService.getPreview(repo);
  }

  @Get("runs")
  getRecentRuns() {
    return this.executionService.listRecentRuns();
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
  transitionInProgressToReady(@Body() body: TransitionWorkItemDto) {
    return this.executionService.transitionInProgressToReady(body.work_item_id);
  }

  @Post("transition-drafting")
  transitionInProgressToDrafting(@Body() body: TransitionWorkItemDto) {
    return this.executionService.transitionInProgressToDrafting(body.work_item_id);
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
    return this.executionService.stream();
  }
}
