import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { WorkItemsService } from "../graph/work-items.service.js";
import { normalizeGitHubRepo } from "../github/events/github-repo-truth-refreshed.event.js";
import { getDefaultWorkingBranch } from "./default-working-branches.js";
import { RunStore } from "./run-store.service.js";
import { WorktreeService } from "./worktree.service.js";

@Injectable()
export class BaseRefSyncService {
  private readonly logger = new Logger(BaseRefSyncService.name);

  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(RunStore) private readonly runStore: RunStore,
    @Inject(WorktreeService) private readonly worktree: WorktreeService,
  ) {}

  refreshRepo(repo: string): void {
    const identity = normalizeGitHubRepo(repo);
    if (!identity) return;
    try {
      // A foreign API event must neither fetch nor invalidate this checkout's proof.
      const origin = this.worktree.runGit(["remote", "get-url", "origin"]).trim();
      if (normalizeGitHubRepo(origin) !== identity) return;
      this.worktree.fetchBaseRef(identity, getDefaultWorkingBranch(identity));
    } catch (error) {
      this.logger.warn(`Base-ref fetch failed for ${identity}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  fastForward(input: { work_item_id: string }) {
    const id = typeof input?.work_item_id === "string" ? input.work_item_id.trim() : "";
    if (!id) throw new BadRequestException("base_ref_sync_invalid_item: work_item_id is required");
    let item;
    try { item = this.workItems.get(id); }
    catch { throw new BadRequestException(`base_ref_sync_invalid_item: Unknown work item ${id}`); }
    const repo = normalizeGitHubRepo(item.repo);
    if (!repo) throw new BadRequestException("base_ref_sync_invalid_repo: Work item requires a valid GitHub repository");
    const pending = this.runStore.listPendingLaunches();
    if (pending.length) throw new BadRequestException(`base_ref_sync_pending_launch: Pending launch for ${pending.join(", ")}`);
    try {
      const active = this.runStore.listActiveRuns();
      if (active.length) throw new BadRequestException(`base_ref_sync_active_run: Active run ${active[0].run_id} for ${active[0].work_item_id} (${active[0].status})`);
      // No await from the global guard through git mutation: launch cannot interleave.
      return this.worktree.fastForwardBaseRef(repo, getDefaultWorkingBranch(repo));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(message.startsWith("base_ref_sync_scan_unavailable:") ? message : `base_ref_sync_git_failed: ${message}`);
    }
  }
}
