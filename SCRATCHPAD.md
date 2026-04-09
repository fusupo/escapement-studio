# Scratchpad: studio-139 — Studio: add graph node context menu with launch execution action

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/139
- **Branch:** studio-139-branch
- **Base ref:** develop
- **Scope hint:** Add a graph-node context menu with issue actions, including launching execution directly from the graph.
- **Created:** 2026-04-09T03:37:06.696Z

## File Ownership

### Owned
- (none predicted)

### Shared
- (none)

### Forbidden
- docs/contracts/github-sync.md
- docs/contracts/run-artifacts.md
- src/modules/execution
- src/modules/github
- src/modules/graph
- src/modules/planning
- src/modules/settings
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/SettingsPanel.svelte
- web/src/components/Sidebar.svelte

## Summary
- The planning graph already exposes node right-click events from the D3 renderer (`web/src/lib/graph.js`) up through `GraphView.svelte` into `web/src/App.svelte`, and `App.svelte` currently contains an inline graph context menu plus launch-eligibility lookup/launch handlers.
- For #139, the implementation work appears to be about hardening and polishing that graph-node action surface so it behaves like a real extensible context menu: anchored to the cursor/node, clear about which actions are available, and routed through the existing execution flow rather than inventing a parallel path.
- The most likely frontend surface is the planning view (`web/src/App.svelte`) plus the graph interaction layer (`web/src/components/GraphView.svelte` and `web/src/lib/graph.js`). If the menu is meant to grow, it would be cleaner to extract it into its own component instead of keeping all action rendering inline in `App.svelte`.

## Acceptance Criteria
- [ ] Right-clicking an eligible graph node opens a context menu anchored to the node/cursor.
- [ ] Eligible issues expose a **Launch execution** action from that menu.
- [ ] The launch action routes into the existing execution flow instead of creating a separate special-case path.
- [ ] Ineligible nodes show disabled or omitted actions with clear affordances.
- [ ] The menu can grow to support additional node actions over time.
- [ ] The menu dismisses cleanly and does not interfere with normal graph selection/pan behavior.

## Implementation Plan
- [x] Audit the existing graph right-click plumbing and identify the exact acceptance gaps versus the current inline implementation. Files: `web/src/App.svelte`, `web/src/components/GraphView.svelte`, `web/src/lib/graph.js`, plus read-only context from `src/modules/execution/execution.service.ts` and `src/modules/execution/types.ts`.
- [x] Extract or reshape the graph-node context menu into a reusable/extensible UI surface so future node actions can be added without growing `App.svelte` further. Files: `web/src/App.svelte`; likely new `web/src/components/GraphNodeContextMenu.svelte`; optional new helper such as `web/src/lib/graph-node-actions.js`.
- [x] Reuse the existing launch-eligibility and launch-execution flow from the planning screen so the menu action follows the same execution path, tab switch, and error handling used elsewhere. Files: `web/src/App.svelte`, and `web/src/lib/api.js` only if a small helper/API wrapper adjustment is needed.
- [x] Tighten menu interaction behavior: anchor/clamp placement, outside-click/Escape dismissal, disabled-state messaging for ineligible nodes, and right-click behavior that does not break normal graph selection or pan/zoom. Files: `web/src/App.svelte`, `web/src/components/GraphView.svelte`, `web/src/lib/graph.js`, and menu styling in component-local CSS or `web/src/app.css`.
- [x] Add targeted coverage for any extracted pure helper logic (if introduced) and then verify the end-to-end UX manually in the planning graph: open menu, launch an eligible node, confirm blocked affordances for ineligible nodes, and confirm dismissal behavior. Files: likely new test file for any helper plus the touched web files above.

## Affected Files
- `SCRATCHPAD.md` — setup-phase plan and implementation notes.
- `web/src/App.svelte` — primary planning-screen state for selected node, context-menu open/close behavior, launch-eligibility lookup, and routing into the existing execution flow.
- `web/src/components/GraphView.svelte` — graph wrapper that passes right-click events and frontier-derived metadata into the renderer.
- `web/src/lib/graph.js` — low-level D3 node interaction handling for click/right-click/tooltip/pan behavior.
- `web/src/components/GraphNodeContextMenu.svelte` *(likely new)* — dedicated graph-node actions menu so the surface can grow beyond a single inline button.
- `web/src/lib/graph-node-actions.js` *(possible new helper)* — pure action-model helper for enabled/disabled/hidden menu items and user-facing reasons.
- `web/src/app.css` *(maybe)* — shared menu/overlay styling if it is not kept component-local.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`)
- [x] Build succeeds (`npm run build:web`)

## Questions / Concerns
- **Scope ambiguity:** the issue text emphasizes eligible **issue-backed** nodes, but the current execution eligibility backend also allows dispatchable capability nodes. Please confirm whether the graph context menu should expose **Launch execution** only for issue-backed items, or for any work item that the existing execution flow considers launchable.
- **Current-code overlap:** `web/src/App.svelte`, `web/src/components/GraphView.svelte`, and `web/src/lib/graph.js` already contain substantial context-menu and launch wiring on `develop`. I will treat #139 as refinement/completion of that surface unless you want a stricter rework.
- **Test surface:** there is no existing frontend component test harness in `web/`. If needed, I can add lightweight Vitest coverage only for extracted pure helpers, then rely on manual UI verification for the actual Svelte interaction behavior.
- Aside from the issue-only vs any-launchable-node question above, the implementation surface is clear.

## Work Log

### 2026-04-09 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-139-branch

### 2026-04-09 - Coding
- Audited the current implementation: `GraphView.svelte` and `web/src/lib/graph.js` already emit node right-click events, and `web/src/App.svelte` already has an inline menu plus launch-eligibility lookup. The main remaining gaps are extensibility, clearer action modeling, and more robust menu positioning/dismissal behavior.
- Extracted the inline planning-graph menu into `web/src/components/GraphNodeContextMenu.svelte` and introduced `web/src/lib/graph-node-actions.js` so actions are modeled separately from `App.svelte` rendering.
- Kept launch execution routed through the existing `handleLaunchExecution()` path in `web/src/App.svelte`, and added an `Open issue` action when a node has a linked GitHub issue.
- Quality checks after extraction/refactor: `npm run check` ✅, `npm run build:web` ✅ (existing Svelte a11y/CSS warnings only), `npm test` ⚠️ fails in existing `graph-writer.service.test.ts` because `better-sqlite3` native bindings are unavailable in this worktree.
- Polished the menu behavior by clamping it to the viewport after render, focusing it so Escape works reliably, and closing it on outside click, outside right-click, scroll, or window resize.
- Quality checks after menu-behavior polish: `npm run check` ✅, `npm run build:web` ✅ (same pre-existing Svelte warnings), `npm test` ⚠️ same existing `better-sqlite3` binding failure.
- Added targeted helper coverage in `src/__tests__/graph-node-actions.test.ts` for action modeling and viewport clamping. `npx vitest run src/__tests__/graph-node-actions.test.ts` passes locally.
- Final pre-summary checks: `npm run check` ✅, `npm run build:web` ✅ (same pre-existing Svelte warnings), `npm test` ⚠️ still blocked by the existing missing `better-sqlite3` native binding in `src/modules/graph/__tests__/graph-writer.service.test.ts`.
- Confirmed the focused helper coverage still passes after the final import-typing fix: `npx vitest run src/__tests__/graph-node-actions.test.ts` ✅.
- Completion summary: the graph context menu is now a dedicated component with a reusable action model, includes launch execution plus issue-link actions, clamps cleanly within the viewport, and continues to route launch requests through the existing execution flow in `App.svelte`.

## Blockers
- Full `npm test` runs are blocked in this worktree by an existing environment issue: `better-sqlite3` native bindings are missing, causing `src/modules/graph/__tests__/graph-writer.service.test.ts` to fail before/independent of this change.
