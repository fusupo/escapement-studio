import { Body, Controller, Get, Inject, MessageEvent, Post, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { PlanningService } from "./planning.service.js";
import type {
  ApproveMutationProposalDto,
  ApprovePlanningMemoryChangeDto,
  SendAgentMessageDto,
} from "./types.js";

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

  @Post("proposals/approve")
  approveProposal(@Body() body: ApproveMutationProposalDto) {
    return this.planningService.approveProposal(body);
  }

  @Post("memory/approve")
  approveMemoryChange(@Body() body: ApprovePlanningMemoryChangeDto) {
    return this.planningService.approveMemoryChange(body);
  }

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.planningService.stream();
  }
}
