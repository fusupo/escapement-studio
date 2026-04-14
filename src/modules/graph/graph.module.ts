import { Module } from "@nestjs/common";
import { EdgesController } from "./edges.controller.js";
import { EdgesService } from "./edges.service.js";
import { GraphController } from "./graph.controller.js";
import { GraphEventsService } from "./graph-events.service.js";
import { GraphService } from "./graph.service.js";
import { GraphWriterService } from "./graph-writer.service.js";
import { WorkItemHsmService } from "./work-item-hsm.service.js";
import { WorkItemsController } from "./work-items.controller.js";
import { WorkItemsService } from "./work-items.service.js";

/**
 * Phase 6a (#235): `SQLiteService` moved to `@Global PlatformModule`
 * (src/platform/). GraphModule no longer provides or exports it.
 * Graph's own services still inject `SQLiteService` directly — it's
 * available via the global platform without an explicit module
 * import.
 */
@Module({
  imports: [],
  controllers: [WorkItemsController, EdgesController, GraphController],
  providers: [
    WorkItemsService,
    EdgesService,
    GraphService,
    GraphEventsService,
    GraphWriterService,
    WorkItemHsmService,
  ],
  exports: [
    WorkItemsService,
    EdgesService,
    GraphService,
    GraphEventsService,
    GraphWriterService,
    WorkItemHsmService,
  ],
})
export class GraphModule {}
