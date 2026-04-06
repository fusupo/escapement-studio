import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { WorkItemsService } from "./work-items.service.js";
import type { CreateWorkItemDto, UpdateWorkItemDto } from "./types.js";

@Controller("api/work-items")
export class WorkItemsController {
  constructor(@Inject(WorkItemsService) private readonly workItems: WorkItemsService) {}

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

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.workItems.delete(id);
  }
}
