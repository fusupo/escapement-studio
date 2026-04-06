import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { ContextService } from "./context.service.js";
import { MemoryService } from "./memory.service.js";
import { PlanningController } from "./planning.controller.js";
import { PlanningService } from "./planning.service.js";

@Module({
  imports: [GraphModule],
  controllers: [PlanningController],
  providers: [PlanningService, ContextService, MemoryService],
  exports: [PlanningService, ContextService, MemoryService],
})
export class PlanningModule {}
