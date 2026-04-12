import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  forwardRef,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ExecutionService } from "../execution/execution.service.js";
import { PlansService } from "../plans/plans.service.js";
import type { WorkItemHsmEvent, WorkItemRecord, UpdateWorkItemDto } from "./types.js";
import { WorkItemHsmService } from "./work-item-hsm.service.js";
import { WorkItemsService } from "./work-items.service.js";
import type { CreateWorkItemDto } from "./types.js";

interface TransitionDto {
  event: WorkItemTransitionEvent;
}

type WorkItemTransitionEvent =
  | "user.start_draft"
  | "user.investigate"
  | "user.defer"
  | "user.undefer"
  | "user.cancel";

const SUPPORTED_TRANSITION_EVENTS = new Set<WorkItemTransitionEvent>([
  "user.start_draft",
  "user.investigate",
  "user.defer",
  "user.undefer",
  "user.cancel",
]);

@Controller("api/work-items")
export class WorkItemsController {
  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(WorkItemHsmService) private readonly hsmService: WorkItemHsmService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
    @Inject(forwardRef(() => PlansService))
    private readonly plansService: PlansService,
  ) {}

  @Get()
  list(
    @Query("repo") repo?: string,
    @Query("state") state?: string,
    @Query("kind") kind?: string,
  ) {
    return this.workItems.list({ repo, state, kind });
  }

  @Get("misaligned")
  findMisaligned() {
    return this.workItems.findMisaligned();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.workItems.get(id);
  }

  @Post()
  create(@Body() body: CreateWorkItemDto) {
    return this.workItems.create(body);
  }

  @Put(":id")
  update(@Param("id") id: string, @Body() body: UpdateWorkItemDto) {
    if (Object.hasOwn(body ?? {}, "state")) {
      throw new BadRequestException(
        "Work item state cannot be updated via PUT /api/work-items/:id. Dispatch an HSM-owned workflow instead.",
      );
    }
    return this.workItems.update(id, body);
  }

  @Post(":id/transition")
  async transition(@Param("id") id: string, @Body() body: TransitionDto) {
    const eventType = body?.event;
    if (!eventType) {
      throw new BadRequestException("transition event `event` is required");
    }

    const workItem = this.workItems.get(id);
    if (!SUPPORTED_TRANSITION_EVENTS.has(eventType)) {
      throw new BadRequestException(
        `Unsupported work-item transition event: ${eventType}`,
      );
    }

    const enabledEvents = new Set(this.hsmService.getEnabledEvents(id));
    if (!enabledEvents.has(eventType)) {
      throw new BadRequestException(
        `HSM event ${eventType} is not enabled from state ${workItem.state}`,
      );
    }

    switch (eventType) {
      case "user.start_draft":
        await this.routeStartDraft(id, workItem);
        break;
      case "user.investigate":
        await this.routeInvestigate(id, workItem);
        break;
      case "user.defer":
      case "user.undefer":
        await this.hsmService.dispatch(id, { type: eventType });
        break;
      case "user.cancel":
        return await this.executionService.cancelWorkItem(id);
    }

    return this.workItems.get(id);
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.workItems.delete(id);
  }

  private async routeStartDraft(id: string, workItem: WorkItemRecord): Promise<void> {
    const leafState = this.leafState(workItem.state);

    if (leafState === "planned" || leafState === "drafting") {
      await this.plansService.prepare(id);
      return;
    }

    if (leafState === "ready") {
      await this.plansService.reopen(id);
      return;
    }

    if (leafState === "in_progress") {
      await this.executionService.transitionInProgressToDrafting(id);
      return;
    }

    throw new BadRequestException(
      `No workflow owns ${workItem.state} -> user.start_draft for ${id}`,
    );
  }

  private async routeInvestigate(id: string, workItem: WorkItemRecord): Promise<void> {
    const leafState = this.leafState(workItem.state);

    if (leafState === "in_progress") {
      await this.executionService.transitionInProgressToReady(id);
      return;
    }

    const result = await this.hsmService.dispatch(id, { type: "user.investigate" });
    if (result.rejected) {
      throw new BadRequestException(
        `HSM rejected user.investigate from state ${result.prev_state}`,
      );
    }
  }

  private leafState(state: string): string {
    return state.startsWith("pre_pr.") ? state.slice("pre_pr.".length) : state;
  }
}
