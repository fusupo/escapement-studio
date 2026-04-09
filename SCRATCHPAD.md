# Scratchpad: studio-145 — Studio: visually indicate in-progress work items in the graph

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/145
- **Branch:** studio-145-branch
- **Base ref:** develop
- **Scope hint:** Add a distinct graph visualization treatment for work items whose state is in_progress, without conflicting with selection, frontier highlighting, or other state styling.
- **Created:** 2026-04-09T03:40:27.475Z

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
- web/src/App.svelte
- web/src/components
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/SettingsPanel.svelte
- web/src/components/Sidebar.svelte
- web/src/lib/api.js

## Summary
The current graph already receives each work item's `state` and uses that state in `web/src/lib/graph.js` to set a single fill color per node. Selection is expressed as a brighter/thicker stroke, hover temporarily changes that stroke, and frontier nodes get an additional striped interior overlay plus glow via `web/src/app.css`. `web/src/components/GraphView.svelte` also exposes a legend for node-state cues.

The gap for this issue is that `in_progress` currently reads mostly as "amber fill" rather than a dedicated in-graph treatment, so active work can be hard to spot at a glance in dense layouts. The likely implementation surface is the graph renderer (`web/src/lib/graph.js`) plus graph styling (`web/src/app.css`), with a legend/status explanation update in `web/src/components/GraphView.svelte` if file ownership allows it.

No backend/API changes appear necessary: `in_progress` is already a valid `WorkItemState` in `src/modules/graph/types.ts`, and the graph payload already includes node state.

## Acceptance Criteria

- [ ] In-progress work items have a distinct visual treatment in the graph.
- [ ] The treatment does not conflict with selected-node styling.
- [ ] The treatment does not conflict with frontier-node indication.
- [ ] The treatment remains distinguishable from done/planned states.
- [ ] The graph still renders clearly in dense views.

## Implementation Plan

- [x] Confirm the exact current composition of graph cues in `web/src/lib/graph.js` and `web/src/app.css`, and choose an in-progress treatment that layers with existing fill, hover, selection stroke, frontier stripes, and PR cues instead of replacing them.
- [x] Update `web/src/lib/graph.js` to mark/render `in_progress` nodes with a dedicated secondary affordance (for example via state-specific classes/data attributes and an additional SVG overlay or inset ring) while preserving the existing base state color mapping and selection behavior.
- [x] Update `web/src/app.css` to style the new in-progress affordance, including composition rules for default, hover, selected, and frontier states so the cue stays legible in dense graph layouts.
- [x] Update the graph legend/state explanation in `web/src/components/GraphView.svelte` so the UI explains the new in-progress treatment rather than showing only a flat amber swatch. This step needs file-ownership clarification because `web/src/components` is currently marked forbidden. *(Handled via `web/src/app.css` styling of the existing legend swatch so no forbidden-file change was needed.)*
- [ ] Verify the result visually in the graph UI with a mix of planned, in-progress, done, selected, and frontier nodes, then run `npm run check`, `npm test`, and `npm run build:web`.

## Affected Files
- `web/src/lib/graph.js` — add renderer metadata/classes and the in-progress-specific node decoration so it composes with existing node rendering.
- `web/src/app.css` — add CSS for the in-progress treatment and for its interaction with hover/selection/frontier styling.
- `web/src/components/GraphView.svelte` — update the graph legend so the in-progress entry explicitly shows and labels the dashed-inset treatment used in the graph.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`)
- [x] Build succeeds (`npm run build:web`)

## Questions / Concerns
- The forbidden-path restriction was explicitly lifted for this execution, so `web/src/components/GraphView.svelte` can now be updated directly.
- `npm test` is currently failing because the worktree is missing the native `better-sqlite3` binding required by existing graph tests; this appears to be an environment issue rather than a regression from the graph styling changes.

## Work Log

### 2026-04-09 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-145-branch

### 2026-04-09 - Implementation
- Chose an in-progress treatment that keeps the existing amber fill but adds an inset dashed overlay so active work remains distinct without competing with outer selection strokes.
- Updated `web/src/lib/graph.js` to add `graph-node--in-progress` / `data-state` metadata and render an in-progress inset overlay that composes with frontier overlays.
- Updated `web/src/app.css` to style the new in-progress overlay, combine its styling with frontier glow/stripes, and restyle the legend swatch to match the new affordance.
- After the forbidden-path restriction was lifted for this execution, updated `web/src/components/GraphView.svelte` so the legend explicitly labels the in-progress treatment as a dashed inset, matching the rendered node styling.
- Ran `npm run check` ✅, `npm run build:web` ✅ (with pre-existing Svelte warnings), and `npm test` ⚠️ failed because `better-sqlite3` native bindings are unavailable in this worktree.
- Re-ran final checks after committing the graph changes: `npm run check` still passes, `npm run build:web` still succeeds with the same pre-existing warnings, and `npm test` still fails for the same missing-native-binding reason.
- Re-ran `npm run check`, `npm run build:web`, and `npm test` after the legend update in `web/src/components/GraphView.svelte`; results were unchanged.
- Implementation work is complete; only full visual verification in a browser session remains outside the available headless tooling in this setup.

## Blockers
- Full browser-side visual verification of the new in-progress treatment was not possible in this headless setup.
- `npm test` is blocked by missing native `better-sqlite3` bindings in this worktree; existing graph tests fail before exercising this change.
