import { Controller, Get, Inject, Query } from "@nestjs/common";
import { UntrackedIssuesService, type UntrackedIssuesResult } from "./untracked-issues.service.js";

/**
 * `GET /api/github/untracked?repo=owner/repo[&refresh=1]` (#281): open
 * issues of an included repo that have no work item. Read-only; the
 * import itself goes through `POST /api/agent/proposals/import`.
 * `refresh=1` re-lists the repo's issues instead of using a listing up
 * to 60 s old.
 */
@Controller("api/github/untracked")
export class UntrackedIssuesController {
  constructor(@Inject(UntrackedIssuesService) private readonly untracked: UntrackedIssuesService) {}

  @Get()
  list(@Query("repo") repo: string, @Query("refresh") refresh?: string): Promise<UntrackedIssuesResult> {
    return this.untracked.list(repo, { refresh: refresh === "1" || refresh === "true" });
  }
}
