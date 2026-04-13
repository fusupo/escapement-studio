import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { RunDispositionService } from "../../run-disposition.service.js";
import type { ArchiveAndCloseMergedPullRequestResult } from "../../types.js";
import { ArchiveAndCloseMergedPullRequestCommand } from "./archive-and-close-merged-pull-request.command.js";

@CommandHandler(ArchiveAndCloseMergedPullRequestCommand)
export class ArchiveAndCloseMergedPullRequestHandler
  implements
    ICommandHandler<
      ArchiveAndCloseMergedPullRequestCommand,
      ArchiveAndCloseMergedPullRequestResult
    >
{
  constructor(
    @Inject(RunDispositionService) private readonly disposition: RunDispositionService,
  ) {}

  async execute(
    command: ArchiveAndCloseMergedPullRequestCommand,
  ): Promise<ArchiveAndCloseMergedPullRequestResult> {
    return await this.disposition.archiveAndCloseMergedPullRequest(command.workItemId);
  }
}
