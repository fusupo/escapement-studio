# Scratchpad: studio-125 — Studio: prevent app title and active section header from overlapping in the top bar

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/125
- **Branch:** studio-125-branch
- **Base ref:** develop
- **Scope hint:** Fix the top-bar layout so the app title and active section label no longer overlap.
- **Created:** 2026-04-08T07:19:52.563Z

## File Ownership

### Owned
- (none predicted)

### Shared
- (none)

### Forbidden
- README.md
- docs/contracts/github-sync.md
- docs/contracts/run-artifacts.md
- src/modules/execution
- src/modules/git
- src/modules/github
- src/modules/graph
- src/modules/planning
- web/src/App.svelte
- web/src/components
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/GraphView.svelte
- web/src/components/PlannerChatAdapter.svelte
- web/src/components/Sidebar.svelte
- web/src/lib/api.js

## Acceptance Criteria

- [ ] `Escapement Studio` does not overlap with the current section title
- [ ] The top bar remains visually stable across supported sections (Planning, Execute, Reconcile, Settings)
- [ ] No header text collision occurs in normal desktop usage

## Summary

The top bar in `App.svelte` uses a flex container with `justify-content: center` to center the brand name ("Escapement Studio"), while the active section label (e.g. "Planning") is positioned with `position: absolute; left: 12px`. This absolute positioning takes the label out of normal flow, causing it to overlap the centered brand text—especially with longer section names.

**Constraint:** `App.svelte` is forbidden. The scoped `<style>` block in that file defines the broken layout. However, since Svelte 5 uses `:where()` for scoped selectors (0 added specificity), global CSS in `app.css` with equal or slightly higher specificity will override the scoped styles.

## Implementation Plan

- [x] **Override title-bar layout in `web/src/app.css`** — Add global CSS rules to:
  1. Change `.title-bar` from centered flex to a 3-column CSS grid: `grid-template-columns: 1fr auto 1fr`. This gives the label, brand, and spacer each their own non-overlapping column.
  2. Remove `position: absolute` and `left: 12px` from `.title-bar-label` (override to `position: static`).
  3. Ensure `.title-bar-brand` stays visually centered in the middle column.
  4. Use specificity like `.main-area > .title-bar` (0,2,0) to reliably override scoped styles (0,1,0 effective).
- [x] **Verify across all tabs** — Check that all section labels (Planning, Execute, Reconcile, Settings) render without collision.
- [x] **Run build** — `npm run build:web` to confirm no errors.
- [x] **Run tests** — `npm test` to confirm nothing breaks.

## Affected Files

- **`web/src/app.css`** — Add global overrides for `.title-bar`, `.title-bar-label`, and `.title-bar-brand` to switch from absolute positioning to CSS grid layout, preventing overlap.

## Quality Checks
- [ ] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`)
- [ ] Build succeeds (`npm run build:web`)

## Questions / Concerns

- **`App.svelte` is forbidden but contains the broken styles.** The plan uses global CSS overrides in `app.css` to fix the layout without modifying `App.svelte`. This works because Svelte 5 scoped styles use `:where()` (zero added specificity). This is the only viable approach given the file ownership constraints. If the team prefers the fix to live in `App.svelte` directly, this issue would need to be re-assigned with different file ownership.
- **No predicted owned files** — The manifest didn't predict any files for this issue. `web/src/app.css` is not in the forbidden list, so modifying it should be acceptable.

## Work Log

### 2026-04-08 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-125-branch

### 2026-04-08 - Implementation
- Added global CSS overrides in `web/src/app.css` to fix title-bar layout
- Used `.main-area > .title-bar` selector (specificity 0,2,0) to override Svelte 5 scoped styles
- Switched from absolute positioning to 3-column CSS grid: `grid-template-columns: 1fr auto 1fr`
- Build passes, pre-existing test failures in graph-writer unrelated to this change
- Committed as `fix(web): prevent app title and section label from overlapping in top bar`

## Blockers
