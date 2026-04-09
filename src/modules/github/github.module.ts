import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { GitHubController } from "./github.controller.js";
import { GitHubService } from "./github.service.js";
import { StudioIssueTemplateService } from "./studio-issue-template.service.js";

@Module({
  imports: [GraphModule],
  controllers: [GitHubController],
  providers: [GitHubService, StudioIssueTemplateService],
  exports: [GitHubService, StudioIssueTemplateService],
})
export class GitHubModule {}
