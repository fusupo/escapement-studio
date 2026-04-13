import { ICommand } from "@nestjs/cqrs";

export class TransitionInProgressToDraftingCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
