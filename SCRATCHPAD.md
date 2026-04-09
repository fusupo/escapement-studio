# Scratchpad: studio-147 — Studio: mark work items in_progress when execution is launched

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/147
- **Branch:** studio-147-branch
- **Base ref:** develop
- **Scope hint:** Update the work item's graph state from planned to in_progress when execution is launched so graph details and styling reflect active work.
- **Created:** 2026-04-09T04:00:58.392Z

## Summary
Launching an execution run currently creates the Studio run and starts orchestration, but the backing work item can remain in `planned` state in the graph store. Because the planning graph, hover/details UI, frontier styling, and execution preview all read from that shared work-item state, active work can continue to render as `planned` even after launch.

The implementation should make the execution launch path in `src/modules/execution/execution.service.ts` transition the launched work item itself from `planned` to `in_progress` as part of accepting the launch, before the asynchronous execution work proceeds. That keeps the source-of-truth graph state aligned with active execution, removes the item from planned/frontier-only views as appropriate, and ensures only the requested work item is marked active.

## File Ownership

### Owned
- src/modules/execution/execution.service.ts

### Shared
- (none)

### Forbidden
- docs/contracts/github-sync.md
- docs/contracts/run-artifacts.md
- src/modules/execution
- src/modules/github
- src/modules/planning
- src/modules/settings
- web/src/App.svelte
- web/src/components
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/SettingsPanel.svelte
- web/src/components/Sidebar.svelte
- web/src/lib/api.js
- web/src/lib/graph.js

## Acceptance Criteria

- [ ] Launching execution for a planned work item advances its Studio graph state to `in_progress`.
- [ ] Graph hover/details surfaces show `in_progress` for active runs.
- [ ] The state transition happens early enough that active execution is reflected promptly after launch.
- [ ] The change does not incorrectly mark unrelated items in progress.
- [ ] In-progress graph styling can rely on this state being accurate.

## Implementation Plan

- [x] Update `src/modules/execution/execution.service.ts` launch acceptance flow so a successful launch mutates the targeted work item from `planned` to `in_progress` before `executeRun(...)` is kicked off.
- [x] Keep the mutation scoped to the launched `work_item_id` in `src/modules/execution/execution.service.ts`, and ensure blocked / rejected launches do not change graph state for this or any other item.
- [x] Preserve existing run creation and orchestration behavior in `src/modules/execution/execution.service.ts` while making the state transition happen early enough that subsequent graph/preview reads observe `in_progress` promptly after launch.
- [x] Verify the backend state flow against the read-only graph consumers (`src/modules/graph/work-items.service.ts`, `src/modules/graph/graph.service.ts`, `web/src/lib/graph.js`, `web/src/App.svelte`, `web/src/components/ExecutionDispatchPanel.svelte`) and run `npm run check` plus targeted tests to confirm the launch path still behaves correctly.

## Affected Files
- `src/modules/execution/execution.service.ts` — mark the launched work item `in_progress` during the accepted launch flow, before async execution proceeds, without affecting unrelated work items.
- `src/modules/execution/__tests__/launch-eligibility.test.ts` — cover launch-time state transitions so planned items move to `in_progress`, already-active items are not re-marked, and blocked launches do not mutate graph state.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`)
- [x] Build succeeds (`npm run build:web`)

## Questions / Concerns
- Implementation scope is clear and fits the owned backend file.
- One caveat: `web/src/App.svelte` does not appear to reload the planning graph immediately after launch, so this backend change will make the source-of-truth state accurate promptly, but already-rendered graph views may still depend on existing refresh/requery behavior to display the updated state instantly.
- I only own `src/modules/execution/execution.service.ts`, so I am planning a backend-only fix and will rely on existing tests/checks unless ownership is expanded to allow test-file updates.

## Work Log

### 2026-04-09 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-147-branch

### 2026-04-09 - Coding
- Updated `src/modules/execution/execution.service.ts` so accepted launches transition the targeted work item from `planned` to `in_progress` before the async execution run starts.
- Kept the mutation scoped to the launched work item only; blocked launches still return early without changing graph state.
- Preserved existing run creation/orchestration flow and added a queued activity message that records when the work item was marked `in_progress`.
- Verified related graph consumers are read-only over work-item state and should pick up the backend transition on their next refresh/requery.
- Ran `npm run check` successfully.
- Ran `npx vitest run src/modules/execution/__tests__/launch-eligibility.test.ts` successfully.
- Ran `npm run build:web` successfully.
- Ran `npm test`, but the suite is currently blocked by missing `better-sqlite3` native bindings in this worktree environment.
- After test-file access was expanded, added targeted execution tests covering launch-time state mutation behavior and re-ran `npx vitest run src/modules/execution/__tests__/launch-eligibility.test.ts` successfully.
- Re-ran `npm run check` successfully after adding the new tests.

## Blockers
- `npm test` fails in this worktree because `better-sqlite3` native bindings are missing (`Could not locate the bindings file`), which affects existing graph-writer tests unrelated to this change.
