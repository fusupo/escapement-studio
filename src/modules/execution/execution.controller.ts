import { Body, Controller, Get, Inject, Post, Query, Sse } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { ExecutionService } from "./execution.service.js";
import type { LaunchExecutionRunDto } from "./types.js";

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

  @Post("launch")
  launch(@Body() body: LaunchExecutionRunDto) {
    return this.executionService.launch(body);
  }

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.executionService.stream();
  }
}
