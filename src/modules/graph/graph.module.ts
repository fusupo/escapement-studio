import { forwardRef, Module } from "@nestjs/common";
import { ExecutionModule } from "../execution/execution.module.js";
import { GitHubModule } from "../github/github.module.js";
import { PlansModule } from "../plans/plans.module.js";
import { EdgesController } from "./edges.controller.js";
import { EdgesService } from "./edges.service.js";
import { GraphController } from "./graph.controller.js";
import { GraphEventsService } from "./graph-events.service.js";
import { GraphService } from "./graph.service.js";
import { GraphWriterService } from "./graph-writer.service.js";
import { HsmActionHandlers } from "./hsm-action-handlers.js";
import { HsmGuardHandlers } from "./hsm-guard-handlers.js";
import { SQLiteService } from "./sqlite.service.js";
import { WorkItemHsmService } from "./work-item-hsm.service.js";
import { WorkItemsController } from "./work-items.controller.js";
import { WorkItemsService } from "./work-items.service.js";

@Module({
  imports: [forwardRef(() => ExecutionModule), forwardRef(() => GitHubModule), forwardRef(() => PlansModule)],
  controllers: [WorkItemsController, EdgesController, GraphController],
  providers: [
    SQLiteService,
    WorkItemsService,
    EdgesService,
    GraphService,
    GraphEventsService,
    GraphWriterService,
    HsmActionHandlers,
    HsmGuardHandlers,
    WorkItemHsmService,
  ],
  exports: [
    SQLiteService,
    WorkItemsService,
    EdgesService,
    GraphService,
    GraphEventsService,
    GraphWriterService,
    HsmActionHandlers,
    HsmGuardHandlers,
    WorkItemHsmService,
  ],
})
export class GraphModule {}
