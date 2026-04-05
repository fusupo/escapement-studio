import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { GraphService } from "./graph.service.js";
import { GraphWriterService } from "./graph-writer.service.js";
import type { ApplyGraphMutationsDto, WorkItemState } from "./types.js";

@Controller("api")
export class GraphController {
  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
  ) {}

  @Get("graph")
  getGraph(
    @Query("repo") repo?: string,
    @Query("state") state?: WorkItemState,
    @Query("track") track?: string,
    @Query("phase") phase?: string,
  ) {
    return this.graphService.getGraph({ repo, state, track, phase });
  }

  @Get("frontier")
  getFrontier(@Query("repo") repo?: string) {
    return this.graphService.getFrontier(repo);
  }

  @Get("plan")
  getPlan(@Query("repo") repo?: string) {
    return this.graphService.getPlan(repo);
  }

  @Post("graph/mutations")
  applyMutations(@Body() body: ApplyGraphMutationsDto) {
    return this.graphWriter.apply(body);
  }
}
