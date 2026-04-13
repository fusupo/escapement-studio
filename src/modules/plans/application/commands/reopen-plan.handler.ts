import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { PlansService } from "../../plans.service.js";
import type { PlanResponse } from "../../types.js";
import { ReopenPlanCommand } from "./reopen-plan.command.js";

@CommandHandler(ReopenPlanCommand)
export class ReopenPlanHandler
  implements ICommandHandler<ReopenPlanCommand, PlanResponse>
{
  constructor(
    @Inject(PlansService) private readonly plans: PlansService,
  ) {}

  async execute(command: ReopenPlanCommand): Promise<PlanResponse> {
    return await this.plans.reopen(command.workItemId);
  }
}
