import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  imports: [GraphModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
