import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { ExecutionController } from "./execution.controller.js";
import { ExecutionService } from "./configured-execution.service.js";

@Module({
  imports: [GraphModule],
  controllers: [ExecutionController],
  providers: [ExecutionService],
  exports: [ExecutionService],
})
export class ExecutionModule {}
