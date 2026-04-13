import { ICommand } from "@nestjs/cqrs";

export class ReopenPlanCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
