import { describe, expect, it, vi } from "vitest";
import { BaseRefSyncService } from "../base-ref-sync.service.js";
import { GitHubRepoTruthRefreshedHandler } from "../events/github-repo-truth-refreshed.handler.js";
import { GitHubRepoTruthRefreshedEvent } from "../../github/events/github-repo-truth-refreshed.event.js";

function harness(repo: string | null = "Fusupo/escapement-studio") {
  const workItems = { get: vi.fn(() => ({ repo })) };
  const store = { listPendingLaunches: vi.fn((): string[] => []), listActiveRuns: vi.fn((): object[] => []) };
  const result = { repo: "fusupo/escapement-studio", base_ref: "develop", previous_ahead: 0, previous_behind: 2, updated: true, safety_check: { code: "base_ref_current", status: "pass", message: "current" } };
  const worktree = { runGit: vi.fn(() => "git@github.com:fusupo/escapement-studio.git"), fetchBaseRef: vi.fn(), fastForwardBaseRef: vi.fn(() => result) };
  const service = new BaseRefSyncService(workItems as any, store as any, worktree as any);
  const warn = vi.fn(); Object.assign(service, { logger: { warn } });
  return { service, workItems, store, worktree, result, warn };
}

describe("BaseRefSyncService", () => {
  it("validates ID and derives default repo/base without accepting client overrides", () => {
    const h = harness();
    expect(() => h.service.fastForward({ work_item_id: " " })).toThrow("base_ref_sync_invalid_item");
    expect(h.workItems.get).not.toHaveBeenCalled();
    expect(h.service.fastForward({ work_item_id: "  studio-273  ", repo: "other/repo", base_ref: "wrong" } as any)).toBe(h.result);
    expect(h.workItems.get).toHaveBeenCalledWith("studio-273");
    expect(h.worktree.fastForwardBaseRef).toHaveBeenCalledWith("fusupo/escapement-studio", "develop");
  });
  it("refuses unknown items and missing repository", () => {
    const h = harness(null);
    expect(() => h.service.fastForward({ work_item_id: "x" })).toThrow("base_ref_sync_invalid_repo");
    h.workItems.get.mockImplementation(() => { throw new Error("unknown"); });
    expect(() => h.service.fastForward({ work_item_id: "x" })).toThrow("base_ref_sync_invalid_item");
    expect(h.worktree.fastForwardBaseRef).not.toHaveBeenCalled();
  });
  it("guards pending launches before disk scan or git mutation", () => {
    const h = harness(); h.store.listPendingLaunches.mockReturnValue(["other-item"]);
    expect(() => h.service.fastForward({ work_item_id: "x" })).toThrow("base_ref_sync_pending_launch: Pending launch for other-item");
    expect(h.store.listActiveRuns).not.toHaveBeenCalled(); expect(h.worktree.fastForwardBaseRef).not.toHaveBeenCalled();
  });
  it.each(["queued", "preparing", "disambiguating", "running"])("refuses global %s runs", status => {
    const h = harness(); h.store.listActiveRuns.mockReturnValue([{ run_id: "other-run", work_item_id: "other-item", status }]);
    expect(() => h.service.fastForward({ work_item_id: "x" })).toThrow(`base_ref_sync_active_run: Active run other-run for other-item (${status})`);
    expect(h.worktree.fastForwardBaseRef).not.toHaveBeenCalled();
  });
  it("surfaces scan refusal and actual git errors without successful response", () => {
    const h = harness(); h.store.listActiveRuns.mockImplementationOnce(() => { throw new Error("base_ref_sync_scan_unavailable: corrupt"); });
    expect(() => h.service.fastForward({ work_item_id: "x" })).toThrow("base_ref_sync_scan_unavailable: corrupt");
    expect(h.worktree.fastForwardBaseRef).not.toHaveBeenCalled();
    h.worktree.fastForwardBaseRef.mockImplementation(() => { throw new Error("origin mismatch"); });
    expect(() => h.service.fastForward({ work_item_id: "x" })).toThrow("base_ref_sync_git_failed: origin mismatch");
  });
  it("routes events only to matching checkout and logs fetch failures", () => {
    const h = harness(), handler = new GitHubRepoTruthRefreshedHandler(h.service);
    handler.handle(new GitHubRepoTruthRefreshedEvent("other/repo", 100));
    handler.handle(new GitHubRepoTruthRefreshedEvent("invalid", 100));
    expect(h.worktree.fetchBaseRef).not.toHaveBeenCalled();
    handler.handle(new GitHubRepoTruthRefreshedEvent("https://github.com/Fusupo/escapement-studio.git", 100));
    expect(h.worktree.fetchBaseRef).toHaveBeenCalledWith("fusupo/escapement-studio", "develop");
    h.worktree.fetchBaseRef.mockImplementationOnce(() => { throw new Error("offline"); });
    expect(() => handler.handle(new GitHubRepoTruthRefreshedEvent("fusupo/escapement-studio", 100))).not.toThrow();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
