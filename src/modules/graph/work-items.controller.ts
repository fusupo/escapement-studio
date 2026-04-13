import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { CancelWorkItemCommand } from "../execution/application/commands/cancel-work-item.command.js";
import { TransitionInProgressToDraftingCommand } from "../execution/application/commands/transition-in-progress-to-drafting.command.js";
import { TransitionInProgressToReadyCommand } from "../execution/application/commands/transition-in-progress-to-ready.command.js";
import type { CancelWorkItemResult } from "../execution/types.js";
import { PreparePlanCommand } from "../plans/application/commands/prepare-plan.command.js";
import { ReopenPlanCommand } from "../plans/application/commands/reopen-plan.command.js";
import type { CreateWorkItemDto, UpdateWorkItemDto, WorkItemRecord } from "./types.js";
import { WorkItemHsmService } from "./work-item-hsm.service.js";
import { WorkItemsService } from "./work-items.service.js";

interface TransitionDto {
  event: WorkItemTransitionEvent;
  confirm_cancel?: boolean;
  cancel_note?: string;
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
    private readonly commandBus: CommandBus,
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
  async transition(
    @Param("id") id: string,
    @Body() body: TransitionDto,
  ): Promise<WorkItemRecord | CancelWorkItemResult> {
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
        return await this.commandBus.execute<CancelWorkItemCommand, CancelWorkItemResult>(
          new CancelWorkItemCommand({
            work_item_id: id,
            confirm_cancel: body.confirm_cancel === true,
            cancel_note: body.cancel_note,
          }),
        );
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
      await this.commandBus.execute(new PreparePlanCommand(id));
      return;
    }

    if (leafState === "ready") {
      await this.commandBus.execute(new ReopenPlanCommand(id));
      return;
    }

    if (leafState === "in_progress") {
      await this.commandBus.execute(new TransitionInProgressToDraftingCommand(id));
      return;
    }

    throw new BadRequestException(
      `No workflow owns ${workItem.state} -> user.start_draft for ${id}`,
    );
  }

  private async routeInvestigate(id: string, workItem: WorkItemRecord): Promise<void> {
    const leafState = this.leafState(workItem.state);

    if (leafState === "in_progress") {
      await this.commandBus.execute(new TransitionInProgressToReadyCommand(id));
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
