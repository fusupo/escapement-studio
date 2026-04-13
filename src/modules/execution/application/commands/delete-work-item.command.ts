import { ICommand } from "@nestjs/cqrs";
import type { DeleteWorkItemDto } from "../../types.js";

export class DeleteWorkItemCommand implements ICommand {
  constructor(public readonly dto: DeleteWorkItemDto) {}
}
