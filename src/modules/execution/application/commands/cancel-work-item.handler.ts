import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { RunDispositionService } from "../../run-disposition.service.js";
import type { CancelWorkItemResult } from "../../types.js";
import { CancelWorkItemCommand } from "./cancel-work-item.command.js";

@CommandHandler(CancelWorkItemCommand)
export class CancelWorkItemHandler
  implements ICommandHandler<CancelWorkItemCommand, CancelWorkItemResult>
{
  constructor(
    @Inject(RunDispositionService) private readonly disposition: RunDispositionService,
  ) {}

  async execute(command: CancelWorkItemCommand): Promise<CancelWorkItemResult> {
    return await this.disposition.cancelWorkItem(command.dto);
  }
}
