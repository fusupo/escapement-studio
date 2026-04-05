import { Module } from "@nestjs/common";
import { EdgesController } from "./edges.controller.js";
import { EdgesService } from "./edges.service.js";
import { GraphController } from "./graph.controller.js";
import { GraphService } from "./graph.service.js";
import { SQLiteService } from "./sqlite.service.js";
import { WorkItemsController } from "./work-items.controller.js";
import { WorkItemsService } from "./work-items.service.js";

@Module({
  controllers: [WorkItemsController, EdgesController, GraphController],
  providers: [SQLiteService, WorkItemsService, EdgesService, GraphService],
  exports: [SQLiteService, WorkItemsService, EdgesService, GraphService],
})
export class GraphModule {}
