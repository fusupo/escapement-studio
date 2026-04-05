import { Body, Controller, Get, Inject, MessageEvent, Post, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { PlanningService } from "./planning.service.js";
import type { SendAgentMessageDto } from "./types.js";

@Controller("api/agent")
export class PlanningController {
  constructor(@Inject(PlanningService) private readonly planningService: PlanningService) {}

  @Get("session")
  getSessionSnapshot() {
    return this.planningService.getSessionSnapshot();
  }

  @Post("message")
  sendMessage(@Body() body: SendAgentMessageDto) {
    return this.planningService.sendMessage(body);
  }

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.planningService.stream();
  }
}
