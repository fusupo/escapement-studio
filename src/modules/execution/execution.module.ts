import { forwardRef, Module } from "@nestjs/common";
import { GitHubModule } from "../github/github.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ExecutionController } from "./execution.controller.js";
import { ExecutionService } from "./execution.service.js";

@Module({
  imports: [forwardRef(() => GraphModule), GitHubModule, SettingsModule],
  controllers: [ExecutionController],
  providers: [ExecutionService],
  exports: [ExecutionService],
})
export class ExecutionModule {}
