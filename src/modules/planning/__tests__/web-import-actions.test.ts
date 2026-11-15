import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getSettings: vi.fn(), importIssues: vi.fn(), listUntrackedIssues: vi.fn() }));
vi.mock("../../../../web/src/lib/api.js", () => api);
// @ts-expect-error Browser helper is intentionally plain JavaScript.
import { createImportActions, emptyImportDialog } from "../../../../web/src/lib/planning/import-actions.js";
const candidates = [{ issue_number: 20 }, { issue_number: 21 }, { issue_number: 22, conflict: "duplicate ID" }];
function setup() {
  const state = { importDialog: emptyImportDialog(), includedRepos: [], filters: { repo: "a/b" } };
  return { state, actions: createImportActions(state, {}) };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue({ repos: { "a/b": { included: true }, "c/d": {}, "e/f": { included: false } } });
  api.listUntrackedIssues.mockResolvedValue({ candidates, open_issues: 3 });
  api.importIssues.mockResolvedValue({ proposal: { proposal_id: "p" } });
});

describe("GitHub import actions", () => {
  it("starts unchecked, toggles a boolean, retains it across repos and resets on reopen", async () => {
    const { state, actions } = setup();
    expect(state.importDialog.suggestRelationships).toBe(false);
    await actions.openImportDialog(); expect(state.includedRepos).toEqual(["a/b", "c/d"]);
    actions.toggleSuggestRelationships(true); expect(state.importDialog.suggestRelationships).toBe(true);
    await actions.selectImportRepo("c/d"); expect(state.importDialog.suggestRelationships).toBe(true);
    actions.closeImportDialog(); expect(state.importDialog.suggestRelationships).toBe(false);
    await actions.openImportDialog(); expect(state.importDialog.suggestRelationships).toBe(false);
    actions.toggleSuggestRelationships(true); actions.toggleSuggestRelationships(false); expect(state.importDialog.suggestRelationships).toBe(false);
  });
  it.each([undefined, false, true])("snapshots exact default/false/true payload (%s) and returns proposal", async (option) => {
    const { state, actions } = setup(); await actions.openImportDialog();
    actions.toggleImportCandidate(20, true); if (option !== undefined) actions.toggleSuggestRelationships(option);
    expect(await actions.stageImport()).toEqual({ proposal_id: "p" });
    expect(api.importIssues).toHaveBeenCalledWith({ repo: "a/b", issue_numbers: [20], ...(option ? { suggest_relationships: true } : {}) });
    expect(state.importDialog).toEqual(emptyImportDialog());
  });
  it("blocks duplicate submits, closing/reopening, toggles and repo changes while staging", async () => {
    const { state, actions } = setup(); await actions.openImportDialog();
    actions.toggleAllImportCandidates(true); actions.toggleSuggestRelationships(true);
    let resolve!: (value: unknown) => void;
    api.importIssues.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const staged = actions.stageImport(); const payload = api.importIssues.mock.calls[0][0];
    actions.closeImportDialog(); await actions.openImportDialog(); await actions.selectImportRepo("c/d");
    actions.toggleSuggestRelationships(false); actions.toggleImportCandidate(20, false); actions.toggleAllImportCandidates(false);
    await actions.loadImportCandidates();
    expect(state.importDialog).toMatchObject({ open: true, staging: true, repo: "a/b", selected: [20, 21], suggestRelationships: true });
    expect(await actions.stageImport()).toBeNull(); expect(api.importIssues).toHaveBeenCalledTimes(1);
    expect(payload.issue_numbers).not.toBe(state.importDialog.selected);
    resolve({ proposal: { proposal_id: "p" } }); expect(await staged).toEqual({ proposal_id: "p" }); expect(state.importDialog.open).toBe(false);
  });
  it("retains selection and option for retry after staging error", async () => {
    const { state, actions } = setup(); await actions.openImportDialog();
    actions.toggleImportCandidate(20, true); actions.toggleSuggestRelationships(true);
    api.importIssues.mockRejectedValueOnce(new Error("Network unavailable"));
    expect(await actions.stageImport()).toBeNull();
    expect(state.importDialog).toMatchObject({ open: true, staging: false, error: "Network unavailable", selected: [20], suggestRelationships: true });
    expect(await actions.stageImport()).toEqual({ proposal_id: "p" });
  });
  it("does not submit or change the option while loading, with no repo, or with no selection", async () => {
    const { state, actions } = setup(); expect(await actions.stageImport()).toBeNull();
    await actions.openImportDialog(); expect(await actions.stageImport()).toBeNull();
    state.importDialog.loading = true; actions.toggleSuggestRelationships(true); expect(state.importDialog.suggestRelationships).toBe(false);
    actions.toggleImportCandidate(20, true); expect(await actions.stageImport()).toBeNull(); expect(api.importIssues).not.toHaveBeenCalled();
  });
  it("ignores stale candidate responses after switching repos or closing", async () => {
    const { state, actions } = setup(); await actions.openImportDialog();
    let resolve!: (value: unknown) => void;
    api.listUntrackedIssues.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const loading = actions.loadImportCandidates(); await actions.selectImportRepo("c/d");
    resolve({ candidates: [{ issue_number: 99 }] }); await loading;
    expect(state.importDialog.candidates).toEqual(candidates);
    api.listUntrackedIssues.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const late = actions.loadImportCandidates(); actions.closeImportDialog(); resolve({ candidates }); await late;
    expect(state.importDialog).toEqual(emptyImportDialog());
  });
});
