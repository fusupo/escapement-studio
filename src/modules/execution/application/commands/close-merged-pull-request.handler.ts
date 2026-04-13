import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { RunDispositionService } from "../../run-disposition.service.js";
import type { CloseMergedPullRequestResult } from "../../types.js";
import { CloseMergedPullRequestCommand } from "./close-merged-pull-request.command.js";

@CommandHandler(CloseMergedPullRequestCommand)
export class CloseMergedPullRequestHandler
  implements ICommandHandler<CloseMergedPullRequestCommand, CloseMergedPullRequestResult>
{
  constructor(
    @Inject(RunDispositionService) private readonly disposition: RunDispositionService,
  ) {}

  async execute(
    command: CloseMergedPullRequestCommand,
  ): Promise<CloseMergedPullRequestResult> {
    return await this.disposition.closeMergedPullRequest(command.workItemId);
  }
}
