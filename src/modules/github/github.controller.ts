import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
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

  @Post("issue/close")
  closeIssue(
    @Body("repo") repo: string,
    @Body("issue_number") issueNumber: number,
  ) {
    return this.githubService.closeIssue(repo, Number(issueNumber));
  }

  @Get("pull-request")
  getPullRequest(
    @Query("repo") repo?: string,
    @Query("pull_request_number") pullRequestNumber?: string,
    @Query("branch") branch?: string,
  ) {
    if (pullRequestNumber) {
      return this.githubService.readPullRequest(repo ?? "", Number(pullRequestNumber));
    }

    return this.githubService.findPullRequestForBranch(repo ?? "", branch ?? "");
  }
}
