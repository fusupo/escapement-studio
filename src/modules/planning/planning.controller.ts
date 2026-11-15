import { Body, Controller, Get, Inject, MessageEvent, Post, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { ImportProposalService, type ImportIssuesDto } from "./import-proposal.service.js";
import { PlanningService } from "./planning.service.js";
import type {
  ApproveGitHubSyncDto,
  ApproveMutationProposalDto,
  ApprovePlanningMemoryChangeDto,
  SendAgentMessageDto,
} from "./types.js";

@Controller("api/agent")
export class PlanningController {
  constructor(
    @Inject(PlanningService) private readonly planningService: PlanningService,
    @Inject(ImportProposalService) private readonly importProposals: ImportProposalService,
  ) {}

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

  /**
   * #281: stage a proposal that imports untracked GitHub issues, with
   * the edges their bodies state. Writes nothing; the proposal is then
   * approved through `proposals/approve` like any other.
   */
  @Post("proposals/import")
  importIssues(@Body() body: ImportIssuesDto) {
    return this.importProposals.stage(body);
  }

  @Post("proposals/dismiss")
  dismissProposals() {
    return this.planningService.dismissAllProposals();
  }

  @Post("memory/approve")
  approveMemoryChange(@Body() body: ApprovePlanningMemoryChangeDto) {
    return this.planningService.approveMemoryChange(body);
  }

  @Post("github/approve")
  approveGitHubSync(@Body() body: ApproveGitHubSyncDto) {
    return this.planningService.approveGitHubSync(body);
  }

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return this.planningService.stream();
  }
}
