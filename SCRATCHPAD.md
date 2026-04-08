# Scratchpad: studio-76 — Studio: let users configure local repo paths and per-repo base/working branches

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/76
- **Branch:** studio-76-branch
- **Base ref:** develop
- **Scope hint:** Allow configuration of local repo paths plus per-repo base and working branches, ideally from a dedicated Settings area.
- **Created:** 2026-04-08T18:09:01.685Z

## File Ownership

### Owned
- web/src/lib/api.js
- src/modules/git
- README.md

### Shared
- (none)

### Forbidden
- docs/contracts/github-sync.md
- docs/contracts/run-artifacts.md
- src/modules/github
- src/modules/graph
- src/modules/planning
- web/src/App.svelte
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/GraphView.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/Sidebar.svelte

## Summary
- Today Studio persists repos as a simple `owner/repo -> { default_branch, included }` map in `SettingsService`, keeps `artifactRoot` as a global config field, and `ExecutionService` assumes `process.cwd()` is the git checkout while `default-working-branches.ts` supplies hardcoded per-repo defaults.
- Issue #76 shifts repo targeting to a real local-checkout model: each repo should be discovered from a filesystem path, validated with `git -C <path>`, derive its GitHub identity from `git remote get-url origin`, suggest an artifact root from `AGENTS.md` / `CLAUDE.md` `context-path`, and persist per-repo settings for `localPath`, `artifactRoot`, `defaultBranch`, and remote metadata.
- The main implementation surface is the settings backend/UI plus execution path resolution: execution preview, safety checks, worktree creation, and run artifact directories need to resolve the configured local checkout and per-repo artifact root instead of using the current worktree root and global artifact root.
- Because settings persistence already exists, this likely needs a backward-compatible settings shape migration so older saved settings continue to load and existing single-repo installs do not break.

## Acceptance Criteria
- [ ] User can add a repo by providing a local directory path
- [ ] Studio validates it's a git repo and reads remote/identity
- [ ] Per-repo artifact root is configurable and used by execution/archive
- [ ] Per-repo default branch replaces hardcoded `default-working-branches.ts`
- [ ] Existing execution and worktree flows use the configured local paths
- [ ] Settings persist across server restarts

## Implementation Plan
- [ ] Extend the settings data model in `src/modules/settings/settings.service.ts` to store richer per-repo config (derived repo slug, local path, artifact root, default branch, remote, included flag), keep only manifest/planning-session config at the Studio level, and add helpers such as `getRepoConfig(repo)` / included-repo listings for downstream services.
- [x] Add git discovery support under `src/modules/git/` (likely `src/modules/git/git.module.ts` and `src/modules/git/git.service.ts`) to validate local directories, read `origin`, derive `owner/repo`, and inspect `AGENTS.md` / `CLAUDE.md` for a suggested `context-path` artifact root.
- [ ] Expose the discovery flow from the settings backend by updating `src/modules/settings/settings.controller.ts` and `src/modules/settings/settings.module.ts` to add `GET /api/settings/repos/discover?path=<dir>` and wire in the new git discovery service.
- [ ] Rework execution repo resolution in `src/modules/execution/execution.module.ts` and `src/modules/execution/execution.service.ts` so preview/launch/safety/worktree creation run git commands against the configured repo local path and place worktrees + run artifacts under that repo's configured artifact root.
- [ ] Remove or deprecate the hardcoded branch map in `src/modules/execution/default-working-branches.ts`, replacing all remaining callers with `SettingsService`-backed per-repo default branch lookup.
- [ ] Add compatibility handling in `src/modules/settings/settings.service.ts` for legacy saved settings (`repos[slug].default_branch` + global `config.artifactRoot`) so existing persisted installs can be promoted into the new shape without losing data.
- [ ] Update the frontend API in `web/src/lib/api.js` and rebuild the repo section of `web/src/components/SettingsPanel.svelte` (with any necessary styling in `web/src/app.css`) around an “Add local directory” flow with validation/discovery feedback, derived remote display, editable artifact root, and editable default branch.
- [ ] Add focused backend tests for discovery, settings migration, and execution repo-path resolution in new or updated test files under `src/modules/git/__tests__/`, `src/modules/settings/__tests__/`, and `src/modules/execution/__tests__/`.
- [x] Update `README.md` to document the new local-directory repo setup flow and how per-repo artifact roots/default branches affect execution worktrees and run artifacts.

## Affected Files
- `src/modules/settings/settings.service.ts` — expand persisted repo settings shape, add repo-config lookup helpers, and handle migration/default merging.
- `src/modules/settings/settings.controller.ts` — add repo discovery endpoint alongside existing get/update settings endpoints.
- `src/modules/settings/settings.module.ts` — wire settings to the new git discovery provider/module.
- `src/modules/git/git.module.ts` *(new)* — Nest module for git/discovery functionality.
- `src/modules/git/git.service.ts` *(new)* — git validation, remote parsing, repo slug derivation, and `AGENTS.md` / `CLAUDE.md` context-path discovery.
- `src/modules/execution/execution.module.ts` — import settings/git dependencies needed by execution.
- `src/modules/execution/execution.service.ts` — resolve configured local repo paths and per-repo artifact roots for preview, safety checks, worktree creation, and run records.
- `src/modules/execution/default-working-branches.ts` — remove/deprecate hardcoded default branch map.
- `web/src/lib/api.js` — add client helper for repo discovery endpoint.
- `web/src/components/SettingsPanel.svelte` — replace manual `owner/repo` entry UI with directory-based discovery/editing flow.
- `web/src/app.css` — style any new repo discovery form states, metadata rows, and validation feedback in Settings.
- `src/modules/git/__tests__/...` *(new)* — cover remote parsing / repo discovery behavior.
- `src/modules/settings/__tests__/...` *(new)* — cover settings persistence and migration behavior.
- `src/modules/execution/__tests__/...` — cover per-repo execution resolution behavior if existing execution tests need to be expanded.
- `README.md` — document user-facing repo configuration changes.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`)
- [x] Build succeeds (`npm run build:web`)

## Questions / Concerns
- The issue title says “base/working branches,” but the detailed body and acceptance criteria only define one per-repo configurable default branch/base ref. I am assuming this means a single per-repo default branch used as the execution base ref, while work item branch names remain graph-driven.
- Existing saved settings only contain repo slugs plus `default_branch` and a global `artifactRoot`. I am assuming the right approach is an in-place migration/merge strategy rather than dropping or resetting existing settings.
- Browser-native directory picking may or may not be practical in the current Svelte/web environment. I am planning around a text-input path flow with server-side discovery/validation first, which still satisfies the issue scope.
- Aside from the branch-field ambiguity above, the implementation surface is clear.

## Work Log

### 2026-04-08 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-76-branch
- Reviewed current settings persistence, settings UI, execution branch/worktree resolution, artifact-root handling, and related docs to map the implementation surface.
- Identified the main changes as: richer repo settings persistence, a new git discovery path, and execution service rewiring away from `process.cwd()` / hardcoded branch defaults.
- Implemented `src/modules/git/git.service.ts` and `src/modules/git/git.module.ts` with repo discovery helpers for git-root validation, `origin` remote lookup, GitHub `owner/repo` derivation, and `AGENTS.md` / `CLAUDE.md` `context-path` artifact-root suggestions.
- Added `src/modules/git/__tests__/git.service.test.ts` to cover remote parsing, context-path parsing, path resolution, and end-to-end repo discovery against temporary git repositories.
- Added `discoverSettingsRepo(path)` to `web/src/lib/api.js` as the frontend REST helper for the planned `GET /api/settings/repos/discover` flow; the Settings UI/backend wiring remains blocked by file ownership.
- Updated `README.md` examples to describe execution worktrees and run artifacts under a repo-specific `<artifact-root>` and documented that repo identity/artifact-root suggestions derive from `origin` and `AGENTS.md` / `CLAUDE.md` `context-path` metadata.
- Final verification: `npm run check` passed, `npm run build:web` passed (with pre-existing Svelte a11y warnings), and `npm test` remains blocked by an existing `better-sqlite3` native binding failure in graph tests.
- Completion summary: delivered the owned git-discovery foundation (`src/modules/git/*`), matching git-discovery tests, an API helper for the planned settings endpoint, and README updates; the settings/execution/UI integration tasks remain blocked by file-ownership limits.

## Blockers
- Ownership constraint: tasks 1, 3, 4, 5, 6, and most of 7 require edits in `src/modules/settings/*`, `src/modules/execution/*`, and `web/src/components/SettingsPanel.svelte` / `web/src/app.css`, all of which are outside this worktree's owned/shared file list. I cannot complete those tasks without permission to edit settings/execution/settings-UI files.
- Test environment constraint: `npm test` is blocked by an existing `better-sqlite3` native binding failure in `src/modules/graph/__tests__/graph-writer.service.test.ts`; the new git tests pass, but the suite is not green globally.
- Need confirmation only if the issue truly expects separate configurable “base branch” and “working branch” fields; otherwise the current plan assumes one per-repo default branch/base ref field.
