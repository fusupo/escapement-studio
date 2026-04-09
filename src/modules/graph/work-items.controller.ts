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
import { isValidHumanTransition } from "./state-transitions.js";
import { WorkItemsService } from "./work-items.service.js";
import type { CreateWorkItemDto, UpdateWorkItemDto, WorkItemState } from "./types.js";

interface TransitionDto {
  to: WorkItemState;
}

@Controller("api/work-items")
export class WorkItemsController {
  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
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
    return this.workItems.update(id, body);
  }

  @Post(":id/transition")
  transition(@Param("id") id: string, @Body() body: TransitionDto) {
    const target = body?.to;
    if (!target) {
      throw new BadRequestException("transition target `to` is required");
    }

    const workItem = this.workItems.get(id);
    if (!isValidHumanTransition(workItem.state, target)) {
      throw new BadRequestException(
        `Human-reviewer transition ${workItem.state} → ${target} is not allowed`,
      );
    }

    // in_progress → ready delegates to ExecutionService per ADR 014 actor
    // assignment: the execution service owns the logic for reviving a
    // failed-but-valid run plan. All other human transitions are plain
    // state updates and go through WorkItemsService directly.
    if (workItem.state === "in_progress" && target === "ready") {
      return this.executionService.transitionInProgressToReady(id);
    }

    return this.workItems.update(id, { state: target });
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.workItems.delete(id);
  }
}
