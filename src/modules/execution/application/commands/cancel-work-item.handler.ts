import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { ExecutionService } from "../../execution.service.js";
import type { CancelWorkItemResult } from "../../types.js";
import { CancelWorkItemCommand } from "./cancel-work-item.command.js";

@CommandHandler(CancelWorkItemCommand)
export class CancelWorkItemHandler
  implements ICommandHandler<CancelWorkItemCommand, CancelWorkItemResult>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(command: CancelWorkItemCommand): Promise<CancelWorkItemResult> {
    return await this.execution.cancelWorkItem(command.dto);
  }
}
