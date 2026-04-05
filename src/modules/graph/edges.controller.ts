import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from "@nestjs/common";
import { EdgesService } from "./edges.service.js";
import type { CreateEdgeDto, UpdateEdgeDto } from "./types.js";

@Controller("api/edges")
export class EdgesController {
  constructor(@Inject(EdgesService) private readonly edges: EdgesService) {}

  @Get()
  list(
    @Query("from_id") from_id?: string,
    @Query("to_id") to_id?: string,
    @Query("rel") rel?: string,
  ) {
    return this.edges.list({ from_id, to_id, rel });
  }

  @Get(":id")
  get(@Param("id", ParseIntPipe) id: number) {
    return this.edges.get(id);
  }

  @Post()
  create(@Body() body: CreateEdgeDto) {
    return this.edges.create(body);
  }

  @Put(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() body: UpdateEdgeDto) {
    return this.edges.update(id, body);
  }

  @Delete(":id")
  delete(@Param("id", ParseIntPipe) id: number) {
    return this.edges.delete(id);
  }
}
