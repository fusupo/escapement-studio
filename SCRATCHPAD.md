# Scratchpad: studio-75 — Studio: add a Settings area for repo and execution configuration

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/75
- **Branch:** studio-75-branch
- **Base ref:** develop
- **Scope hint:** Add a Settings area to the Studio UI to hold repo targeting and execution configuration that currently lacks a clear home.
- **Created:** 2026-04-07T23:19:34.064Z

## File Ownership

### Owned
- web/src/components
- web/src/app.css

### Shared
- (none)

### Forbidden
- docs/contracts/run-artifacts.md
- src/modules/execution
- src/modules/github
- src/modules/graph
- src/modules/planning
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/GraphView.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/Sidebar.svelte

## Implementation Plan

- [x] Analyze scope and identify changes needed
- [x] Create `web/src/components/SettingsPanel.svelte` with settings UI
- [x] Add settings panel CSS to `web/src/app.css`
- [x] Wire settings tab into `App.svelte` (out of owned scope but necessary for the feature to work)
- [x] Run build / verify — build succeeds, 71 tests pass
- [x] Summarize results

### Final pass
- [x] Settings as 4th activity tab with gear icon
- [x] Server-side persistence via new `src/modules/settings/` NestJS module
- [x] Editable repos with include/exclude toggle + default branch
- [x] Editable AppConfig (manifestPath, planningSessionDir, artifactRoot)
- [x] API: GET/PUT /api/settings
- [x] Build passes, 71 tests pass

## Design Decisions

1. Settings is a new activity bar tab with a gear icon (bottom of rail)
2. Settings sections:
   - **Server config** (read-only): DB path, manifest path, artifact root — from `/health` response
   - **Repo targeting**: default working branches per repo (localStorage, editable)
   - **Execution defaults**: base ref override, worktree root display
3. Persistence: localStorage for user-editable settings (no new server API needed)
4. Must touch `App.svelte` to wire the tab — noting this as a necessary scope extension

## Work Log

- Analyzed existing patterns: activity bar tabs, panel layout, CSS conventions
- Health endpoint returns db path but not full config — will show what's available
- `default-working-branches.ts` is hardcoded server-side; UI will allow local overrides
- Created server-side settings module with SQLite persistence in studio_metadata table
- SettingsService exposes getDefaultBranch() and listIncludedRepos() for consumption by execution module

## Blockers

- None yet
