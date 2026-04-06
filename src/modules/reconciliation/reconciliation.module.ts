import { Module } from "@nestjs/common";
import { ExecutionModule } from "../execution/execution.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { ReconciliationController } from "./reconciliation.controller.js";
import { ReconciliationService } from "./reconciliation.service.js";

@Module({
  imports: [GraphModule, ExecutionModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
