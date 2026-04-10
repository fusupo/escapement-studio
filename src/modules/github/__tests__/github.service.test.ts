import { describe, expect, it, vi } from "vitest";
import { GitHubService } from "../github.service.js";
import type { WorkItemRecord } from "../../graph/types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-91",
    name: "Refresh cached GitHub truth",
    kind: "issue",
    state: "open_pr",
    repo: "fusupo/escapement-studio",
    issue_number: 91,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/91",
    scope_hint: "Refresh stale GitHub truth",
    branch: "studio-91-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T00:00:00Z",
    ...overrides,
  };
}

function applyPatch(workItem: WorkItemRecord, patch: Partial<WorkItemRecord>): WorkItemRecord {
  return {
    ...workItem,
    ...patch,
    meta: patch.meta ?? workItem.meta,
    updated_at: "2026-04-09T00:01:00Z",
  };
}

describe("GitHubService reconciliation", () => {
  it("reconciles stale issue metadata into linked work items", async () => {
    const workItem = makeWorkItem({
      meta: {
        github_issue: {
          title: "Old title",
          url: "https://github.com/fusupo/escapement-studio/issues/91",
          state: "OPEN",
          labels: [],
          assignees: [],
        },
      },
    });

    const update = vi.fn((id: string, patch: Partial<WorkItemRecord>) => {
      expect(id).toBe(workItem.id);
      return applyPatch(workItem, patch);
    });

    const service = new GitHubService({ getDb: () => ({}) } as any, {
      listByRepoIssueNumber: vi.fn(() => [workItem]),
      update,
    } as any);

    (service as any).runGhJson = vi.fn().mockResolvedValue({
      number: 91,
      title: "New title",
      body: "Issue body",
      url: "https://github.com/fusupo/escapement-studio/issues/91",
      state: "CLOSED",
      labels: [{ name: "bug", color: "ff0000" }],
      assignees: [{ login: "marc", name: "Marc" }],
    });

    const result = await service.readIssue("fusupo/escapement-studio", 91);

    expect(update).toHaveBeenCalledWith("studio-91", {
      issue_url: "https://github.com/fusupo/escapement-studio/issues/91",
      meta: expect.objectContaining({
        github_issue: expect.objectContaining({
          title: "New title",
          state: "CLOSED",
          labels: [{ name: "bug", color: "ff0000", description: undefined }],
          assignees: [{ login: "marc", name: "Marc" }],
        }),
      }),
    });
    expect(result.reconciliation?.updated_work_item_ids).toEqual(["studio-91"]);
    expect(result.reconciliation?.work_items).toHaveLength(1);
    expect(result.reconciliation?.work_items[0]?.meta).toMatchObject({
      github_issue: expect.objectContaining({ title: "New title", state: "CLOSED" }),
    });
  });

  it("reconciles stale pull request truth into linked work items and runs", async () => {
    const workItem = makeWorkItem({
      meta: {
        pull_request: {
          number: 70,
          url: "https://github.com/fusupo/escapement-studio/pull/70",
          title: "Refresh cached GitHub truth",
          is_draft: false,
          head_ref: "studio-91-branch",
          base_ref: "develop",
          state: "OPEN",
          merged_at: null,
        },
      },
    });

    const update = vi.fn((id: string, patch: Partial<WorkItemRecord>) => {
      expect(id).toBe(workItem.id);
      return applyPatch(workItem, patch);
    });

    const service = new GitHubService({ getDb: () => ({}) } as any, {
      listByRepoPullRequestNumber: vi.fn(() => []),
      listByRepoBranch: vi.fn(() => [workItem]),
      update,
    } as any);

    service.registerPullRequestTruthRefresher(() => ({ updated_run_ids: ["exec_123"] }));

    (service as any).runGhJson = vi.fn().mockResolvedValue({
      number: 70,
      url: "https://github.com/fusupo/escapement-studio/pull/70",
      title: "Refresh cached GitHub truth",
      body: "PR body",
      state: "MERGED",
      isDraft: false,
      baseRefName: "develop",
      headRefName: "studio-91-branch",
      mergedAt: "2026-04-09T00:00:00Z",
      mergeCommit: { oid: "abc123" },
    });

    const result = await service.readPullRequest("fusupo/escapement-studio", 70);

    expect(update).toHaveBeenCalledWith("studio-91", {
      state: "merged_pr",
      meta: expect.objectContaining({
        pull_request: expect.objectContaining({
          number: 70,
          state: "MERGED",
          merged_at: "2026-04-09T00:00:00Z",
          merge_commit_sha: "abc123",
        }),
      }),
    });
    expect(result.reconciliation).toEqual({
      updated_work_item_ids: ["studio-91"],
      updated_run_ids: ["exec_123"],
      work_items: [expect.objectContaining({ id: "studio-91", state: "merged_pr" })],
    });
  });

  describe("merged PR state advancement", () => {
    function openPrWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
      return makeWorkItem({
        state: "open_pr",
        meta: {
          pull_request: {
            number: 70,
            url: "https://github.com/fusupo/escapement-studio/pull/70",
            title: "Refresh cached GitHub truth",
            is_draft: false,
            head_ref: "studio-91-branch",
            base_ref: "develop",
            state: "OPEN",
            merged_at: null,
          },
        },
        ...overrides,
      });
    }

    function buildService(workItem: WorkItemRecord) {
      const update = vi.fn((id: string, patch: Partial<WorkItemRecord>) => {
        expect(id).toBe(workItem.id);
        return applyPatch(workItem, patch);
      });
      const service = new GitHubService({ getDb: () => ({}) } as any, {
        listByRepoPullRequestNumber: vi.fn(() => []),
        listByRepoBranch: vi.fn(() => [workItem]),
        update,
      } as any);
      service.registerPullRequestTruthRefresher(() => ({ updated_run_ids: [] }));
      return { service, update };
    }

    function mockMergedPr(service: GitHubService, mergedAt: string | null) {
      (service as any).runGhJson = vi.fn().mockResolvedValue({
        number: 70,
        url: "https://github.com/fusupo/escapement-studio/pull/70",
        title: "Refresh cached GitHub truth",
        body: "PR body",
        state: mergedAt ? "MERGED" : "OPEN",
        isDraft: false,
        baseRefName: "develop",
        headRefName: "studio-91-branch",
        mergedAt,
        mergeCommit: mergedAt ? { oid: "abc123" } : null,
      });
    }

    it("advances open_pr to merged_pr when the fetched PR is merged", async () => {
      const workItem = openPrWorkItem();
      const { service, update } = buildService(workItem);
      mockMergedPr(service, "2026-04-09T00:00:00Z");

      const result = await service.readPullRequest("fusupo/escapement-studio", 70);

      expect(update).toHaveBeenCalledTimes(1);
      const patch = update.mock.calls[0]![1] as Partial<WorkItemRecord>;
      expect(patch.state).toBe("merged_pr");
      expect(result.reconciliation?.updated_work_item_ids).toEqual(["studio-91"]);
      expect(result.reconciliation?.work_items).toHaveLength(1);
      expect(result.reconciliation?.work_items[0]?.state).toBe("merged_pr");
    });

    it("leaves already merged_pr work items stable (idempotent)", async () => {
      const workItem = openPrWorkItem({
        state: "merged_pr",
        meta: {
          pull_request: {
            number: 70,
            url: "https://github.com/fusupo/escapement-studio/pull/70",
            title: "Refresh cached GitHub truth",
            is_draft: false,
            head_ref: "studio-91-branch",
            base_ref: "develop",
            state: "MERGED",
            merged_at: "2026-04-09T00:00:00Z",
            merge_commit_sha: "abc123",
          },
        },
      });
      const { service, update } = buildService(workItem);
      mockMergedPr(service, "2026-04-09T00:00:00Z");

      const result = await service.readPullRequest("fusupo/escapement-studio", 70);

      // Nothing changed — neither state nor PR meta — so update is not called.
      expect(update).not.toHaveBeenCalled();
      expect(result.reconciliation?.updated_work_item_ids).toEqual([]);
      expect(result.reconciliation?.work_items[0]?.state).toBe("merged_pr");
    });

    it("does not rewrite work items in unrelated states to merged_pr", async () => {
      const workItem = openPrWorkItem({ state: "in_progress" });
      const { service, update } = buildService(workItem);
      mockMergedPr(service, "2026-04-09T00:00:00Z");

      const result = await service.readPullRequest("fusupo/escapement-studio", 70);

      // PR meta still refreshes, but state must NOT be touched.
      expect(update).toHaveBeenCalledTimes(1);
      const patch = update.mock.calls[0]![1] as Partial<WorkItemRecord>;
      expect(patch.state).toBeUndefined();
      expect(patch.meta).toBeDefined();
      expect(result.reconciliation?.work_items[0]?.state).toBe("in_progress");
    });

    it("does not change work item state when the fetched PR is not merged", async () => {
      const workItem = openPrWorkItem();
      const { service, update } = buildService(workItem);
      mockMergedPr(service, null);

      const result = await service.readPullRequest("fusupo/escapement-studio", 70);

      // PR meta may refresh (state OPEN vs stored OPEN is already same so no change)
      // but even if it did, no state field should be included in the patch.
      if (update.mock.calls.length > 0) {
        const patch = update.mock.calls[0]![1] as Partial<WorkItemRecord>;
        expect(patch.state).toBeUndefined();
      }
      expect(result.reconciliation?.work_items[0]?.state).toBe("open_pr");
    });
  });
});
