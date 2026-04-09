import { forwardRef, Module } from "@nestjs/common";
import { ExecutionModule } from "../execution/execution.module.js";
import { EdgesController } from "./edges.controller.js";
import { EdgesService } from "./edges.service.js";
import { GraphController } from "./graph.controller.js";
import { GraphService } from "./graph.service.js";
import { GraphWriterService } from "./graph-writer.service.js";
import { SQLiteService } from "./sqlite.service.js";
import { WorkItemsController } from "./work-items.controller.js";
import { WorkItemsService } from "./work-items.service.js";

@Module({
  imports: [forwardRef(() => ExecutionModule)],
  controllers: [WorkItemsController, EdgesController, GraphController],
  providers: [SQLiteService, WorkItemsService, EdgesService, GraphService, GraphWriterService],
  exports: [SQLiteService, WorkItemsService, EdgesService, GraphService, GraphWriterService],
})
export class GraphModule {}
