# Issue #153 — Expand work item state machine with drafting/ready/merged_pr (ADR 014 step 3)

**Archived:** 2026-04-09
**Branch:** `153-state-machine-drafting-ready-merged-pr`
**Code SHA at archive:** `a3e9fbc` (develop)
**PR:** [fusupo/escapement-studio#161](https://github.com/fusupo/escapement-studio/pull/161) (merged 2026-04-09)
**Issue:** [fusupo/escapement-studio#153](https://github.com/fusupo/escapement-studio/issues/153)
**Status:** Merged

---

## Summary

Implemented ADR 014 step 3: expanded the work item state machine from 6 to 9
states by adding `drafting`, `ready`, and `merged_pr`. Wired each new transition
at its owning service, exposed a human-reviewer transition endpoint, and taught
the frontier/dispatch logic to accept `ready` as launchable. Shipped a full
state-machine allowlist, a circular-dep-aware controller wiring, and 35 new
tests across three files.

## Key Decisions

All four open questions were resolved in the Phase 3.5 Q&A before coding began
(see SCRATCHPAD_153.md "Decisions Made" for the full record):

1. **`planned → ready` shortcut?** → **No.** The lifecycle always goes
   `planned → drafting → ready`. Removing the shortcut keeps the state graph
   predictable and avoids a second "ready without review" back-door.

2. **Where does `sync` land a merged PR?** → **`merged_pr`.** Post-merge sync
   transitions `open_pr → merged_pr`, leaving `merged_pr → done` to the
   disposition flow (ADR 014 step 7 / issue #83). Frontend merged-PR badge
   logic was updated to render for both `done` and `merged_pr`.

3. **What happens to an `in_progress` run when a human wants to revise?** →
   **Expose `in_progress → ready` via a human endpoint for MVP.** Long-term the
   right answer is to stay in `in_progress` with sophisticated run tracking,
   but for MVP a human-triggered rollback is the least-risky path. Delegated
   to `ExecutionService.transitionInProgressToReady` so run bookkeeping stays
   colocated with the rest of the execution lifecycle.

4. **New state colors?** → **Derive from the existing GitHub-inspired palette.**
   `drafting` = `#79c0ff` (lighter planned blue), `ready` = `#56d364` (vivid
   green), `merged_pr` = `#8957e5` (darker done purple). Legend reordered to
   match the canonical lifecycle flow.

## Files Changed

**Types & persistence (Tasks 1–2):**
- `src/modules/graph/types.ts` — 9-state `WorkItemState` union
- `src/modules/graph/sqlite.service.ts` — CHECK constraint + migration guard
  sentinel flipped from `open_pr` to `merged_pr`

**Frontier & dispatch (Task 3):**
- `src/lib/manifest-core.ts` — re-exports upstream helpers and types so
  Studio can build a local dispatch plan without touching node_modules
- `src/modules/graph/graph.service.ts` — `queryStudioFrontier` +
  `buildStudioDispatchPlan` (local reimplementation that includes `ready`
  state items alongside `planned`)

**Execution lifecycle (Tasks 4–6):**
- `src/modules/execution/execution.service.ts`
  - `markWorkItemInProgressOnLaunch`: accepts both `planned` and `ready`
  - `transitionInProgressToReady(workItemId)`: new helper, validates state
  - `syncMergedPullRequest`: transitions `open_pr → merged_pr` (not `done`)

**State transition allowlist & controller (Task 7):**
- `src/modules/graph/state-transitions.ts` (new) —
  `VALID_HUMAN_TRANSITIONS` map + `isValidHumanTransition` helper
- `src/modules/graph/work-items.controller.ts` — `POST :id/transition`
  endpoint with allowlist validation; delegates `in_progress → ready` to
  `ExecutionService`
- `src/modules/graph/graph.module.ts` + `src/modules/execution/execution.module.ts`
  — `forwardRef` on both sides to resolve the new circular dependency

**UI (Tasks 8–9):**
- `web/src/components/GraphView.svelte` — legend reordered, 3 new rows
- `web/src/lib/graph.js` — `STATE_COLORS` entries for new states; merged-PR
  badge render check accepts `merged_pr` in addition to `done`

**Tests (Tasks 10–12):**
- `src/__tests__/state-machine-allowlist.test.ts` (new, 6 tests) — uses
  `Object.create(SQLiteService.prototype)` harness to exercise the real
  `migrateWorkItemStates` private method against an in-memory DB
- `src/modules/execution/__tests__/launch-eligibility.test.ts` (+4 tests) —
  `ready → in_progress` launch path + `transitionInProgressToReady` happy
  path and rejection cases
- `src/modules/graph/__tests__/work-item-transitions.test.ts` (new, 26 tests)
  — every allowed transition, disallowed rejections, delegation verification,
  input validation, and `state-transitions` helper coverage

## Quality Gates

All three passed before opening the PR:

- `npx tsc --noEmit` — clean
- `npx vitest run` — **171/171** tests across 18 files (+35 tests from this issue)
- `npx vite build --config web/vite.config.ts` — 1.37s clean (only pre-existing
  CSS unused-selector warnings)

## Lessons Learned

- **Stale LSP diagnostics are persistent noise** — phantom errors on
  `execution.service.ts` and `graph.service.ts` during and after refactors
  claimed missing exports and unresolved identifiers that tsc reported as
  clean. Continuing to trust `tsc --noEmit` as the source of truth saved
  probably an hour of chasing ghosts. Same pattern as the 152 session.

- **Circular deps across bounded-context modules are solvable with
  `forwardRef` at two levels** — once at the `@Module({ imports: [...] })`
  declarations on both sides, and once at the provider injection site
  (`@Inject(forwardRef(() => ExecutionService))`). Putting the transition
  endpoint on `WorkItemsController` kept all work-item HTTP routes
  colocated, which was worth the extra wiring.

- **Reimplementing upstream helpers locally is cheaper than monkey-patching**
  — the frontier query in `escapement/src/core/planner.ts` hardcodes
  `state = 'planned'`. Rather than forking the package, re-exporting its
  state-agnostic helpers through `manifest-core.ts` and building a
  Studio-local `buildStudioDispatchPlan` worked cleanly and kept the
  upstream dependency unmodified.

- **Bundling related tasks into single commits reduced churn** — Tasks 4+5
  (execution.service.ts changes), 8+9 (legend + colors), and 10+11+12
  (all test files) each collapsed into one commit. Eight total commits for
  twelve tasks felt about right — smaller commits would have been empty
  ceremony.
