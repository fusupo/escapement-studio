import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { ExecutionService } from "../../execution.service.js";
import type { WorkItemRecord } from "../../../graph/types.js";
import { TransitionInProgressToDraftingCommand } from "./transition-in-progress-to-drafting.command.js";

@CommandHandler(TransitionInProgressToDraftingCommand)
export class TransitionInProgressToDraftingHandler
  implements ICommandHandler<TransitionInProgressToDraftingCommand, WorkItemRecord>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(
    command: TransitionInProgressToDraftingCommand,
  ): Promise<WorkItemRecord> {
    return await this.execution.transitionInProgressToDrafting(command.workItemId);
  }
}
