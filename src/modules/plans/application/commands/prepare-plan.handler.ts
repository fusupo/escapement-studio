import { Inject } from "@nestjs/common";
import { CommandHandler, ICommandHandler } from "@nestjs/cqrs";
import { PlansService } from "../../plans.service.js";
import type { PlanResponse } from "../../types.js";
import { PreparePlanCommand } from "./prepare-plan.command.js";

@CommandHandler(PreparePlanCommand)
export class PreparePlanHandler
  implements ICommandHandler<PreparePlanCommand, PlanResponse>
{
  constructor(
    @Inject(PlansService) private readonly plans: PlansService,
  ) {}

  async execute(command: PreparePlanCommand): Promise<PlanResponse> {
    return await this.plans.prepare(command.workItemId);
  }
}
