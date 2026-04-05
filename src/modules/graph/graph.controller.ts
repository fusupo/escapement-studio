import { Controller, Get, Inject, Query } from "@nestjs/common";
import { GraphService } from "./graph.service.js";
import type { WorkItemState } from "./types.js";

@Controller("api")
export class GraphController {
  constructor(@Inject(GraphService) private readonly graphService: GraphService) {}

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
}
