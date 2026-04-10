import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { PlansService } from "./plans.service.js";
import type { ApprovePlanDto, PlanResponse, ReopenPlanDto } from "./types.js";

/**
 * ADR 014 step 4 — plan preparation REST endpoints.
 *
 * See `src/modules/plans/plans.service.ts` for the lifecycle contract.
 */
@Controller("api/plans")
export class PlansController {
  constructor(@Inject(PlansService) private readonly plansService: PlansService) {}

  @Post(":work_item_id/prepare")
  async prepare(@Param("work_item_id") workItemId: string): Promise<PlanResponse> {
    return await this.plansService.prepare(workItemId);
  }

  @Post(":work_item_id/approve")
  approve(
    @Param("work_item_id") workItemId: string,
    @Body() body: ApprovePlanDto = {},
  ): PlanResponse {
    return this.plansService.approve(workItemId, body);
  }

  @Post(":work_item_id/reopen")
  reopen(
    @Param("work_item_id") workItemId: string,
    @Body() body: ReopenPlanDto = {},
  ): PlanResponse {
    return this.plansService.reopen(workItemId, body);
  }

  @Get(":work_item_id")
  get(@Param("work_item_id") workItemId: string): PlanResponse {
    return this.plansService.get(workItemId);
  }
}
