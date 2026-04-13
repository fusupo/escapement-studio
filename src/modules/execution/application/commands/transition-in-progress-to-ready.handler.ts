import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { ExecutionService } from "../../execution.service.js";
import type { WorkItemRecord } from "../../../graph/types.js";
import { TransitionInProgressToReadyCommand } from "./transition-in-progress-to-ready.command.js";

@CommandHandler(TransitionInProgressToReadyCommand)
export class TransitionInProgressToReadyHandler
  implements ICommandHandler<TransitionInProgressToReadyCommand, WorkItemRecord>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(
    command: TransitionInProgressToReadyCommand,
  ): Promise<WorkItemRecord> {
    return await this.execution.transitionInProgressToReady(command.workItemId);
  }
}
