import { Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { ExecutionController } from "./execution.controller.js";
import { ExecutionService } from "./configured-execution.service.js";

@Module({
  imports: [GraphModule, GitHubModule],
  controllers: [ExecutionController],
  providers: [ExecutionService],
  exports: [ExecutionService],
})
export class ExecutionModule {}
