import { ICommand } from "@nestjs/cqrs";

export class ArchiveAndCloseMergedPullRequestCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
