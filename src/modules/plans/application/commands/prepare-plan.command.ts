import { ICommand } from "@nestjs/cqrs";

export class PreparePlanCommand implements ICommand {
  constructor(public readonly workItemId: string) {}
}
