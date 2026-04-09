# Scratchpad: studio-142 — Studio: visually indicate frontier nodes in the graph with non-conflicting styling

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/142
- **Branch:** studio-142-branch
- **Base ref:** develop
- **Scope hint:** Add a non-conflicting visual indicator for frontier/dispatchable graph nodes, potentially using diagonal striping.
- **Created:** 2026-04-09T02:40:58.965Z

## File Ownership

### Owned
- web/src/app.css
- web/src/lib/graph.js
- web/src/components/GraphView.svelte

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
- web/src/lib/api.js

## Summary
The planning graph is rendered as an SVG via `web/src/components/GraphView.svelte`, with node visuals created in `web/src/lib/graph.js`. Today, node fill color communicates work-item state, while selection and hover are both expressed through node stroke changes on the rendered `<rect>`. The issue asks for frontier / dispatchable nodes to gain an additional visual treatment that remains readable without colliding with those existing selection and hover affordances.

Based on the current implementation surface, a non-stroke treatment such as a subtle diagonal stripe overlay is the right direction because selection and hover already consume stroke color/width. However, the current graph renderer appears to set node styles inline and does not expose any frontier-specific class or data attribute in the SVG output, so I do not currently see a CSS-only hook that would let `web/src/app.css` distinguish frontier nodes from non-frontier nodes.

## Acceptance Criteria
- [x] Frontier nodes are visually distinguishable in the graph.
- [x] The styling does not conflict with selected-node highlighting.
- [x] Hover, selected, and frontier states compose cleanly.
- [ ] If diagonal striping is used, it remains legible at the current node sizes and density. (Needs human visual spot-check.)

## Implementation Plan
- [x] Confirm the available styling hooks for graph nodes and determine whether frontier membership is already exposed to the DOM; if not, request ownership expansion because the current SVG node output in `web/src/lib/graph.js` does not appear to expose a frontier-specific selector. Files: `SCRATCHPAD.md` (tracking), context reads in `web/src/lib/graph.js`, `web/src/components/GraphView.svelte`, `web/src/app.css`.
- [x] Define the intended frontier treatment in `web/src/app.css` so it layers with existing state fill colors and leaves stroke-based hover/selection intact; prefer an interior overlay/pattern treatment over a new border treatment.
- [x] Pending ownership expansion, add the frontier hook where graph nodes are rendered so CSS can target dispatchable items cleanly without relying on brittle DOM assumptions. Files likely required: `web/src/lib/graph.js`; possibly `web/src/components/GraphView.svelte` if the graph legend also needs a frontier entry.
- [ ] Verify the composed states visually in the planning graph: frontier only, frontier + hover, frontier + selected, and dense-node readability at current graph zoom/size. Files: `web/src/app.css` plus manual browser verification. **Blocked:** no browser session is available in this harness for an actual visual spot-check.

## Affected Files
- `SCRATCHPAD.md` — setup notes, scope understanding, implementation plan, and execution log.
- `web/src/app.css` — frontier overlay styling, hover/selected composition rules, and legend swatch styling.
- `web/src/lib/graph.js` — frontier-aware node classification, stripe pattern definition, overlay rect rendering, selected class toggling, and tooltip metadata.
- `web/src/components/GraphView.svelte` — fetch current frontier IDs, pass them to the renderer, and add a legend entry for frontier nodes.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`) — blocked by missing `better-sqlite3` native bindings in existing graph tests in this worktree.
- [x] Build succeeds (`npm run build:web`) — build completed with pre-existing Svelte accessibility / unused-selector warnings in forbidden files.

## Questions / Concerns
- Ownership expansion resolved the renderer-hook concern.
- Remaining limitation: I can validate structure/build behavior from the harness, but I cannot perform an actual browser-eye visual check here. A quick human spot-check in Studio is still recommended.

## Work Log

### 2026-04-09 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-142-branch
- Reviewed `web/src/app.css`, `web/src/components/GraphView.svelte`, `web/src/lib/graph.js`, `web/src/App.svelte`, and supporting graph API/backend files for frontier data flow.
- Identified a likely scope/ownership mismatch: the requested behavior appears to require a renderer/data hook outside the owned stylesheet.

### 2026-04-09 - Coding
- Confirmed the graph renderer did not initially emit a frontier-specific class, id, data attribute, or pattern definition that stylesheet-only work could target.
- Added initial frontier styling hooks to `web/src/app.css` for a non-stroke glow plus diagonal-stripe overlay/legend treatment designed to compose with hover and selection stroke states.
- Ran `npm run check` ✅, `npm test` ❌ (environmental failure: missing `better-sqlite3` native bindings in existing graph tests), and `npm run build:web` ✅ (with pre-existing warnings in forbidden Svelte files).
- Created commit `ca23d4d` — `style(graph): scaffold frontier node styling hooks`.
- After ownership expansion, updated `web/src/lib/graph.js` to classify frontier nodes, define a diagonal stripe SVG pattern, render inset overlay rects, and preserve selected-node stroke highlighting.
- Updated `web/src/components/GraphView.svelte` to fetch `/api/frontier`, intersect with currently visible graph items, pass frontier IDs into the renderer, and expose a legend row for frontier nodes.
- Refined `web/src/app.css` so the overlay stays interior to the node and composes with hover/selection.
- Re-ran `npm run check` ✅, `npm test` ❌ (same pre-existing `better-sqlite3` binding failure), and `npm run build:web` ✅ (same pre-existing warnings in forbidden Svelte files).
- Created commit `199de3a` — `feat(graph): highlight frontier nodes in the graph`.
- Final status: implementation is complete in code and builds successfully; remaining follow-up is a quick in-browser visual spot-check for stripe legibility at real graph density.

## Blockers
- Manual visual spot-check is still pending because this harness does not provide a browser session for interactive verification.
- `npm test` remains blocked by missing `better-sqlite3` native bindings in existing graph tests in this worktree.
