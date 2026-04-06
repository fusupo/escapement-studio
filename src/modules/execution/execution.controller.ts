import { Body, Controller, Get, Inject, Param, Post, Query, Sse } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { ExecutionService } from "./execution.service.js";
import type { CleanupWorktreeDto, CreateExecutionPullRequestDto, LaunchExecutionRunDto, SyncMergedExecutionDto } from "./types.js";

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

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.executionService.stream();
  }
}
