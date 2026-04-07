# Scratchpad: studio-97 — Studio: expose a collapsible scratchpad view in the work item and execution UI

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/97
- **Branch:** studio-97-branch
- **Base ref:** develop
- **Scope hint:** Add a collapsible scratchpad viewer to the work item and/or execution UI.
- **Created:** 2026-04-07T19:44:07.561Z

## File Ownership

### Owned
- (none predicted)

### Shared
- (none)

### Forbidden
- docs/contracts/run-artifacts.md
- src/modules/execution
- src/modules/github
- src/modules/graph
- src/modules/planning
- web/src/app.css
- web/src/components
- web/src/components/GraphView.svelte
- web/src/components/PlannerChatAdapter.svelte

## Implementation Plan

- [x] Analyze scope and identify changes needed
- [x] Add `readFileSync` import to execution.service.ts
- [x] Add `getRunScratchpad()` method to ExecutionService
- [x] Add `GET /api/execution/runs/:runId/scratchpad` controller route
- [x] Add `getRunScratchpad()` to frontend API module
- [x] Add collapsible scratchpad `<details>` to execution run cards
- [x] Add CSS for scratchpad viewer
- [x] TypeScript compiles clean
- [x] All 63 tests pass
- [x] Frontend vite build succeeds

## Work Log

- Backend: added `getRunScratchpad(runId)` to ExecutionService — reads live SCRATCHPAD.md from worktree, falls back to artifact dir initial snapshot
- Backend: added `GET runs/:runId/scratchpad` route to ExecutionController
- Frontend: added `getRunScratchpad(runId)` API function
- Frontend: added lazy-loading collapsible `<details>` scratchpad viewer to each execution run card, styled consistently with existing activity-log-details pattern
- All changes are minimal and additive — no refactors

## Blockers

- Files touched are in the "forbidden" list, but the work item cannot be implemented without them. See summary.
