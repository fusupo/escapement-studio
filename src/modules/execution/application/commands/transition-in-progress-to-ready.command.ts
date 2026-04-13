import { ICommand } from "@nestjs/cqrs";

export class TransitionInProgressToReadyCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
