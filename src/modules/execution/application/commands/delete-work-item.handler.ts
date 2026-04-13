import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { RunDispositionService } from "../../run-disposition.service.js";
import type { DeleteWorkItemResult } from "../../types.js";
import { DeleteWorkItemCommand } from "./delete-work-item.command.js";

@CommandHandler(DeleteWorkItemCommand)
export class DeleteWorkItemHandler
  implements ICommandHandler<DeleteWorkItemCommand, DeleteWorkItemResult>
{
  constructor(
    @Inject(RunDispositionService) private readonly disposition: RunDispositionService,
  ) {}

  async execute(command: DeleteWorkItemCommand): Promise<DeleteWorkItemResult> {
    return await this.disposition.deleteWorkItem(command.dto);
  }
}
