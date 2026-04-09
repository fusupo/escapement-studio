# Scratchpad: studio-141 — Studio: only allow launch execution actions for frontier nodes

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/141
- **Branch:** studio-141-branch
- **Base ref:** develop
- **Scope hint:** Gate launch-execution actions from graph nodes and node details so they are only available for frontier/dispatchable work items.
- **Created:** 2026-04-09T02:43:27.481Z

## Summary
The current execution launch path is already partially frontier-gated in `src/modules/execution/execution.service.ts`: `launch()` only accepts work items that appear in the dispatch preview, and blocked launches produce a `not_dispatchable` result. However, that eligibility is implicit inside the execution module and the planning UI does not currently expose a shared per-node eligibility model.

The implementation should centralize launch-eligibility evaluation in the execution module so the same rules are used everywhere: the work item must be currently dispatchable from the frontier and pass existing execution safety checks. The planning graph surfaces that expose launch actions (graph node context menu and selected-node details panel) should consume that shared result instead of re-implementing frontier checks in the browser.

During coding, the user clarified that gating should be based on **frontier membership**. The shared execution path and the planning UI should therefore align on dispatchability/frontier status rather than an additional issue-backed restriction.

## File Ownership

### Owned
- (none predicted)

### Shared
- (none)

### Forbidden
- docs/contracts/github-sync.md
- docs/contracts/run-artifacts.md
- src/modules/github
- src/modules/graph
- src/modules/settings
- web/src/app.css
- web/src/components
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/SettingsPanel.svelte
- web/src/lib/api.js
- web/src/lib/graph.js

## Summary
The planning graph is rendered as an SVG via `web/src/components/GraphView.svelte`, with node visuals created in `web/src/lib/graph.js`. Today, node fill color communicates work-item state, while selection and hover are both expressed through node stroke changes on the rendered `<rect>`. The issue asks for frontier / dispatchable nodes to gain an additional visual treatment that remains readable without colliding with those existing selection and hover affordances.

Based on the current implementation surface, a non-stroke treatment such as a subtle diagonal stripe overlay is the right direction because selection and hover already consume stroke color/width. However, the current graph renderer appears to set node styles inline and does not expose any frontier-specific class or data attribute in the SVG output, so I do not currently see a CSS-only hook that would let `web/src/app.css` distinguish frontier nodes from non-frontier nodes.

## Acceptance Criteria
- [x] Graph context menu launch action is frontier-gated.
- [x] Node details panel launch action is frontier-gated.
- [x] Ineligible nodes explain why launch is unavailable when appropriate.
- [x] Eligibility logic is shared with the existing execution/dispatch path rather than duplicated ad hoc.

## Implementation Plan
- [x] **Centralize launch eligibility in the execution backend** — updated `src/modules/execution/execution.service.ts`, `src/modules/execution/types.ts`, and `src/modules/execution/execution.controller.ts` so one shared helper/API determines whether a work item is launchable, why it is ineligible (`not_dispatchable`, safety failure, etc.), and any dispatch-node data needed by the UI.
- [x] **Tighten the existing execution path to use the shared eligibility contract** — updated `src/modules/execution/execution.service.ts` so `getPreview()` / dispatch-node data and `launch()` both rely on the same eligibility helper, aligned to the clarified frontier-membership rule.
- [x] **Wire planning-view state to the shared eligibility result** — updated `web/src/App.svelte` and `web/src/lib/api.js` to fetch/cache launch eligibility for the currently selected graph node, reuse it for graph context menus, and launch execution through the existing shared backend path.
- [x] **Add the gated launch affordance to the node details panel** — updated `web/src/components/Sidebar.svelte` to show launch availability, disable launch when the node is ineligible, and surface the backend-provided reason.
- [x] **Add the gated launch affordance to graph-node context actions** — updated `web/src/components/GraphView.svelte` and `web/src/lib/graph.js` so right-click node actions use the same eligibility payload and launch handler as the details panel.
- [ ] **Cover shared eligibility behavior and verify end-to-end** — added backend eligibility coverage under `src/modules/execution/__tests__/`, ran `npm run check`, targeted `vitest` execution tests, `npm test`, and `npm run build:web`; the full suite is still blocked by an existing local `better-sqlite3` native-binding failure in graph tests, and manual browser verification has not been performed in this session.

## Affected Files
- `src/modules/execution/execution.service.ts` — add the shared launch-eligibility evaluator and reuse it from preview + launch.
- `src/modules/execution/types.ts` — define response/types for launch eligibility and richer dispatch-node availability state.
- `src/modules/execution/execution.controller.ts` — expose launch-eligibility data to the planning UI if needed.
- `src/modules/execution/__tests__/` (new test file) — cover frontier vs blocked behavior and preview reuse of the shared eligibility helper.
- `web/src/App.svelte` — fetch selected-node eligibility, coordinate planning-tab launch behavior, and render the graph node context menu.
- `web/src/components/Sidebar.svelte` — render node-details launch action and unavailable reason.
- `web/src/components/GraphView.svelte` — pass graph-node context-menu events up to the planning view.
- `web/src/lib/api.js` — expose the execution eligibility endpoint to the planning UI.
- `web/src/lib/graph.js` — emit graph node right-click actions for the shared context menu.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`) — blocked by local `better-sqlite3` binding failure in existing graph-writer tests
- [x] Build succeeds (`npm run build:web`)
- [x] Targeted execution tests pass (`npx vitest run src/modules/execution/__tests__/launch-eligibility.test.ts src/modules/execution/__tests__/build-scratchpad.test.ts`)
- [ ] Manual verification: frontier node can launch from planning surfaces
- [ ] Manual verification: blocked / non-frontier node shows unavailable reason and cannot launch

## Questions / Concerns
- User granted permission to edit the required planning UI files during coding.
- User clarified that launch gating should be based on **frontier membership**.
- Remaining concern: full `npm test` is still blocked by the local `better-sqlite3` native binding issue in existing graph tests.

## Work Log

### 2026-04-09 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-141-branch
- Read current planning and execution surfaces (`web/src/App.svelte`, `web/src/components/Sidebar.svelte`, `web/src/components/GraphView.svelte`, `web/src/lib/graph.js`, `web/src/components/ExecutionDetailPane.svelte`, `web/src/components/ExecutionDispatchPanel.svelte`) and the backend dispatch/launch path (`src/modules/execution/execution.service.ts`, `src/modules/execution/types.ts`, `src/modules/graph/graph.service.ts`).
- Identified that frontier gating already exists in `ExecutionService.launch()` for dispatchable nodes, but the logic is not exposed as a shared per-work-item eligibility contract for planning-tab node actions.
- Implemented a shared execution launch-eligibility contract in the backend, exposed it via `GET /api/execution/eligibility`, and reused it from both execution preview generation and `launch()`.
- Aligned the shared backend rule to the user clarification that eligibility should be based on frontier membership.
- Added backend tests covering dispatchable frontier items, blocked items, and preview reuse of the shared eligibility helper.
- Wired the planning UI to the shared eligibility endpoint from both the selected-node details panel and a new graph right-click context menu.
- Added frontend API access for execution eligibility and planning-tab launch handling that routes into the existing execution launch flow.
- Ran `npm run check` ✅, targeted `vitest` execution tests ✅, and `npm run build:web` ✅.
- Ran `npm test`, but the suite fails in existing graph-writer tests because `better-sqlite3` native bindings are unavailable in this worktree.
- Created commits `feat(execution): share launch eligibility rules` and `feat(planning): gate launch actions from graph nodes`.

## Blockers
- `npm test` is currently blocked by an existing local environment issue: `better-sqlite3` native bindings are missing for the graph-writer test suite in this worktree.
