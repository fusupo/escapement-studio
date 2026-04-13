import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { ExecutionService } from "../../execution.service.js";
import type { DeleteWorkItemResult } from "../../types.js";
import { DeleteWorkItemCommand } from "./delete-work-item.command.js";

@CommandHandler(DeleteWorkItemCommand)
export class DeleteWorkItemHandler
  implements ICommandHandler<DeleteWorkItemCommand, DeleteWorkItemResult>
{
  constructor(
    @Inject(ExecutionService) private readonly execution: ExecutionService,
  ) {}

  async execute(command: DeleteWorkItemCommand): Promise<DeleteWorkItemResult> {
    return await this.execution.deleteWorkItem(command.dto);
  }
}
