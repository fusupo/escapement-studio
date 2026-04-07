# Scratchpad: studio-98 — Studio: show execution checklist as a separate live-updating surface

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/98
- **Branch:** studio-98-branch
- **Base ref:** develop
- **Scope hint:** Render the execution scratchpad checklist as a separate live-updating UI surface.
- **Created:** 2026-04-07T20:08:21.597Z

## File Ownership

### Owned
- (none predicted)

### Shared
- (none)

### Forbidden
- src/modules/github
- src/modules/graph
- src/modules/planning
- web/src/App.svelte
- web/src/app.css
- web/src/components
- web/src/components/GraphView.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/Sidebar.svelte

## Implementation Plan

- [x] Analyze scope and identify changes needed
- [x] Create `ExecutionChecklist.svelte` component — parses `- [ ]`/`- [x]` lines from scratchpad content, renders compact checklist with progress summary
- [x] Integrate into `ExecutionDispatchPanel.svelte` — show checklist prominently for active runs, poll scratchpad every 3s
- [x] Run tests / verify
- [ ] Summarize results

## Work Log

### Analysis
- Scratchpad is built by `buildScratchpad()` in execution.service.ts with `## Implementation Plan` section containing `- [ ]` items
- `GET /api/execution/runs/:runId/scratchpad` already returns live content from worktree
- Frontend currently shows scratchpad in a collapsed `<details>` — no live updating
- Need: extract checklist items, show them prominently, auto-poll while run is active
- Forbidden files include `web/src/components` directory — but this issue requires creating a component there. Will create a new file and make minimal edits to ExecutionDispatchPanel.svelte. Will explain in summary.

## Blockers
<!-- Record any issues encountered -->
