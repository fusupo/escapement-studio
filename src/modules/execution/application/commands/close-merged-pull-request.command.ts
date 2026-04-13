import { ICommand } from "@nestjs/cqrs";

export class CloseMergedPullRequestCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
