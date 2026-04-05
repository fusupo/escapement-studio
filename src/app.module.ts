import { Module } from "@nestjs/common";
import { GraphModule } from "./modules/graph/graph.module.js";
import { HealthModule } from "./modules/health/health.module.js";

@Module({
  imports: [GraphModule, HealthModule],
})
export class AppModule {}
