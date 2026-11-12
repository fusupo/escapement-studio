import { Inject } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { GitHubRepoTruthRefreshedEvent } from "../../github/events/github-repo-truth-refreshed.event.js";
import { BaseRefSyncService } from "../base-ref-sync.service.js";

@EventsHandler(GitHubRepoTruthRefreshedEvent)
export class GitHubRepoTruthRefreshedHandler implements IEventHandler<GitHubRepoTruthRefreshedEvent> {
  constructor(@Inject(BaseRefSyncService) private readonly sync: BaseRefSyncService) {}

  handle(event: GitHubRepoTruthRefreshedEvent): void {
    // API timestamp is not a successful git-fetch timestamp.
    this.sync.refreshRepo(event.repo);
  }
}
