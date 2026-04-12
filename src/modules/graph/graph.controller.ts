import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Sse, type MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { GraphEventsService } from "./graph-events.service.js";
import { GraphService } from "./graph.service.js";
import { GraphWriterService } from "./graph-writer.service.js";
import type { ApplyGraphMutationsDto, WorkItemState } from "./types.js";

@Controller("api")
export class GraphController {
  constructor(
    @Inject(GraphService) private readonly graphService: GraphService,
    @Inject(GraphWriterService) private readonly graphWriter: GraphWriterService,
    @Inject(GraphEventsService) private readonly graphEvents: GraphEventsService,
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

  @Sse("graph/stream")
  stream(): Observable<MessageEvent> {
    return this.graphEvents.stream();
  }

  @Post("graph/mutations")
  applyMutations(@Body() body: ApplyGraphMutationsDto) {
    const illegalStateMutation = body.mutations.find(
      (mutation) => mutation.kind === "update_work_item" && Object.hasOwn(mutation.patch, "state"),
    );
    if (illegalStateMutation) {
      throw new BadRequestException(
        "Graph mutations may not update work item state directly. Dispatch an HSM-owned workflow instead.",
      );
    }
    return this.graphWriter.apply(body);
  }
}
