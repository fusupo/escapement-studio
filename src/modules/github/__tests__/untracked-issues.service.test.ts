import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CachedIssue } from "../github-batch-cache.service.js";
import { UntrackedIssuesService } from "../untracked-issues.service.js";

const STUDIO = "fusupo/escapement-studio";
const SPIRAL = "corpus-relica/spiral-time";

const issue = (number: number, state: "open" | "closed" = "open"): CachedIssue => ({
  number, state, closed_at: null, url: `https://github.com/x/y/issues/${number}`, title: `Issue ${number}`,
});

interface Item { id: string; name: string; repo: string | null; issue_number: number | null }

function setup(issues: CachedIssue[], items: Item[], included = [STUDIO, SPIRAL]) {
  const cache = {
    listIssues: vi.fn(async () => new Map(issues.map((entry) => [entry.number, entry]))),
    invalidate: vi.fn(),
  };
  const workItems = {
    list: vi.fn((filters: { repo?: string } = {}) => items.filter((item) => !filters.repo || item.repo === filters.repo)),
    deriveIssueId: vi.fn((repo: string, number: number) => `${repo === STUDIO ? "studio" : "spiral-time"}-${number}`),
  };
  const settings = { listIncludedRepos: () => included };
  const service = new UntrackedIssuesService(cache as never, workItems as never, settings as never);
  return { service, cache, workItems };
}

describe("UntrackedIssuesService (#281)", () => {
  it("lists open issues that no work item of the repo is linked to, newest first", async () => {
    const { service, cache } = setup(
      [issue(1), issue(2), issue(3, "closed"), issue(4)],
      [{ id: "studio-1", name: "One", repo: STUDIO, issue_number: 1 }],
    );

    const result = await service.list(STUDIO);

    expect(result.open_issues).toBe(3);
    expect(result.candidates.map((candidate) => candidate.issue_number)).toEqual([4, 2]);
    expect(result.candidates[0]).toEqual({
      repo: STUDIO, issue_number: 4, title: "Issue 4", issue_url: "https://github.com/x/y/issues/4",
      derived_id: "studio-4", initial_state: "planned", conflict: null,
    });
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it("scans an included repo that has no work items at all", async () => {
    const { service } = setup([issue(5)], [{ id: "studio-5", name: "Five", repo: STUDIO, issue_number: 5 }]);
    const result = await service.list(SPIRAL);
    expect(result.candidates.map((candidate) => candidate.derived_id)).toEqual(["spiral-time-5"]);
    expect(result.candidates[0].conflict).toBeNull();
  });

  it("deduplicates by repo plus issue number, not by number alone", async () => {
    const { service } = setup([issue(5)], [{ id: "whatever", name: "Tracked", repo: SPIRAL, issue_number: 5 }]);
    expect((await service.list(SPIRAL)).candidates).toEqual([]);
    expect((await service.list(STUDIO)).candidates).toHaveLength(1);
  });

  it("flags a candidate whose derived ID another work item already holds", async () => {
    const { service } = setup([issue(5)], [{ id: "spiral-time-5", name: "Hand-made", repo: null, issue_number: null }]);
    const [candidate] = (await service.list(SPIRAL)).candidates;
    expect(candidate.conflict).toBe('ID spiral-time-5 is already used by "Hand-made"');
  });

  it("re-lists on refresh", async () => {
    const { service, cache } = setup([], []);
    await service.list(STUDIO, { refresh: true });
    expect(cache.invalidate).toHaveBeenCalledWith(STUDIO);
  });

  it("matches the repo case-insensitively and uses the slug from Settings", async () => {
    const { service, cache } = setup([], []);
    expect((await service.list("Fusupo/Escapement-Studio")).repo).toBe(STUDIO);
    expect(cache.listIssues).toHaveBeenCalledWith(STUDIO);
  });

  it("refuses a repo that is not included in Settings, without calling GitHub", async () => {
    const { service, cache } = setup([], [], [STUDIO]);
    await expect(service.list(SPIRAL)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list("")).rejects.toBeInstanceOf(BadRequestException);
    expect(cache.listIssues).not.toHaveBeenCalled();
  });
});
