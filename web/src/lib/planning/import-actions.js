import { getSettings, importIssues, listUntrackedIssues } from "../api.js";

export const emptyImportDialog = () => ({
    open: false,
    repo: "",
    loading: false,
    staging: false,
    suggestRelationships: false,
    error: "",
    openIssues: 0,
    /** @type {any[]} */
    candidates: [],
    /** @type {number[]} */
    selected: [],
});

/**
 * Import of untracked GitHub issues (#281): the repos included in
 * Settings, the candidate list for one of them, and staging the
 * selected issues as a proposal. Nothing here changes the graph; the
 * staged proposal goes through the normal review.
 * @param {any} s
 * @param {any} _actions
 */
export function createImportActions(s, _actions) {
    let listToken = 0;

    /** Repos included in Settings; they feed the import dialog and the repo filter. */
    async function loadIncludedRepos() {
        try {
            const settings = await getSettings();
            const repos = settings?.repos && typeof settings.repos === "object" && !Array.isArray(settings.repos) ? settings.repos : {};
            s.includedRepos = Object.entries(repos)
                .filter(([, info]) => /** @type {any} */ (info)?.included !== false)
                .map(([slug]) => slug)
                .sort();
        }
        catch {
            // Keep the last known list; the filter still shows repos that have work items.
        }
        return s.includedRepos;
    }

    async function openImportDialog() {
        if (s.importDialog.staging) return;
        s.importDialog = { ...emptyImportDialog(), open: true, loading: true };
        const repos = await loadIncludedRepos();
        if (!s.importDialog.open)
            return;
        const repo = repos.includes(s.filters.repo) ? s.filters.repo : repos[0] ?? "";
        s.importDialog = { ...s.importDialog, repo, loading: false };
        if (repo)
            await loadImportCandidates({ refresh: false });
    }

    function closeImportDialog() {
        if (s.importDialog.staging) return;
        listToken += 1;
        s.importDialog = emptyImportDialog();
    }

    /** @param {string} repo */
    async function selectImportRepo(repo) {
        if (s.importDialog.staging) return;
        s.importDialog = { ...s.importDialog, repo, candidates: [], selected: [], openIssues: 0, error: "" };
        if (repo)
            await loadImportCandidates({ refresh: false });
    }

    /** @param {{ refresh?: boolean }} [options] */
    async function loadImportCandidates(options = {}) {
        if (s.importDialog.staging) return;
        const repo = s.importDialog.repo;
        if (!repo)
            return;
        const token = ++listToken;
        s.importDialog = { ...s.importDialog, loading: true, error: "" };
        try {
            const result = await listUntrackedIssues(repo, options);
            if (token !== listToken)
                return;
            const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
            const importable = new Set(candidates.filter((candidate) => !candidate.conflict).map((candidate) => candidate.issue_number));
            s.importDialog = {
                ...s.importDialog,
                loading: false,
                candidates,
                openIssues: result?.open_issues ?? 0,
                selected: s.importDialog.selected.filter((/** @type {number} */ number) => importable.has(number)),
            };
        }
        catch (error) {
            if (token !== listToken)
                return;
            s.importDialog = { ...s.importDialog, loading: false, candidates: [], selected: [], error: /** @type {Error} */ (error).message };
        }
    }

    /** @param {number} issueNumber @param {boolean} checked */
    function toggleImportCandidate(issueNumber, checked) {
        if (s.importDialog.staging) return;
        const selected = s.importDialog.selected.filter((/** @type {number} */ number) => number !== issueNumber);
        s.importDialog = { ...s.importDialog, selected: checked ? [...selected, issueNumber] : selected };
    }

    /** @param {boolean} checked */
    function toggleAllImportCandidates(checked) {
        if (s.importDialog.staging) return;
        s.importDialog = {
            ...s.importDialog,
            selected: checked
                ? s.importDialog.candidates.filter((/** @type {any} */ candidate) => !candidate.conflict).map((/** @type {any} */ candidate) => candidate.issue_number)
                : [],
        };
    }

    /** @param {boolean} checked */
    function toggleSuggestRelationships(checked) {
        if (s.importDialog.loading || s.importDialog.staging) return;
        s.importDialog = { ...s.importDialog, suggestRelationships: Boolean(checked) };
    }

    /**
     * Stage the selected issues as one proposal. Resolves with the staged
     * proposal (the dialog closes), or null when staging failed and the
     * error is shown in the dialog.
     */
    async function stageImport() {
        const { repo, selected, staging, loading, suggestRelationships } = s.importDialog;
        if (!repo || selected.length === 0 || staging || loading)
            return null;
        s.importDialog = { ...s.importDialog, staging: true, error: "" };
        try {
            const result = await importIssues({ repo, issue_numbers: [...selected], suggest_relationships: Boolean(suggestRelationships) });
            s.importDialog = { ...s.importDialog, staging: false };
            closeImportDialog();
            return result?.proposal ?? null;
        }
        catch (error) {
            s.importDialog = { ...s.importDialog, staging: false, error: /** @type {Error} */ (error).message };
            return null;
        }
    }

    return { loadIncludedRepos, openImportDialog, closeImportDialog, selectImportRepo, loadImportCandidates, toggleImportCandidate, toggleAllImportCandidates, toggleSuggestRelationships, stageImport };
}
