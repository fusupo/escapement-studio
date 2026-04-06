import { Controller, Get, Inject, Query } from "@nestjs/common";
import { GitHubService } from "./github.service.js";

@Controller("api/github")
export class GitHubController {
  constructor(@Inject(GitHubService) private readonly githubService: GitHubService) {}

  @Get("issue")
  getIssue(
    @Query("repo") repo?: string,
    @Query("issue_number") issueNumber?: string,
  ) {
    return this.githubService.readIssue(repo ?? "", Number(issueNumber));
  }
}
