import { ICommand } from "@nestjs/cqrs";
import type { CancelWorkItemDto } from "../../types.js";

export class CancelWorkItemCommand implements ICommand {
  constructor(public readonly dto: CancelWorkItemDto) {}
}
