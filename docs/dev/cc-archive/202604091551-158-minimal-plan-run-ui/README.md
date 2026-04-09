# Issue #158 — Studio: minimal UI exposure for plan/run lifecycle (ADR 014 step 8)

**Archived:** 2026-04-09
**Branch:** `158-minimal-plan-run-ui`
**Code SHA:** `fd30500` (merge commit)
**PR:** fusupo/escapement-studio#166 (merged 2026-04-09)
**Status:** Merged
**Epic:** ADR 014 — final step (8 of 8)

## Summary

Wired the final piece of ADR 014 — minimal UI exposure of the plan + run
lifecycle in Studio. All backend endpoints (`POST /api/plans/:id/prepare`,
`/approve`, `/reopen`, `GET /api/plans/:id`) already shipped in ADR 014 step 4
(#154); this issue was a pure frontend wiring task that exposed those flows
through the sidebar execution card and the graph node context menu.

Users can now Prepare a plan, Review the scratchpad in a modal, Approve the
plan, and Launch execution — all from the node actions surface. The Launch
button is now gated on `state === "ready"` in the UI (stricter than the backend,
which still accepts `planned` as a transitional fallback) to push users through
the approved-plan flow.

## Key Decisions

- **Surface: Sidebar + context menu** — Plan actions appear in both the
  execution card of the sidebar *and* the graph node context menu, using a
  single source of truth (`buildGraphNodeContextMenu`). No separate floating
  surface needed.

- **Plan review modal: full-page overlay** — First overlay primitive in the
  project. `role="presentation"` outer with click-to-dismiss, `role="dialog"
  aria-modal="true"` inner card with `click|stopPropagation`. Escape key closes.
  Scrollable `<pre>` renders the raw scratchpad markdown.

- **Include explicit Approve plan button** — Rather than auto-approving on
  review dismissal, show an explicit Approve button while `planState === "drafting"`
  so reviewers make an intentional transition.

- **Two-call plan state model** — Work item state lives on the graph response;
  plan sub-state requires `GET /api/plans/:id`. Auto-fetch only triggers for
  `kind === "issue"` items in states where a plan should exist (drafting, ready,
  in_progress, open_pr, merged_pr). Terminal states and `planned` items skip the
  fetch to avoid unnecessary round-trips.

- **404 as expected state for `planned` items** — `GET /api/plans/:id` throws
  `NotFoundException` for planned items without a plan dir yet. Caught in
  `ensurePlanState`, cached as `null` to prevent re-fetching on reactive ticks.

- **Discovered-during-planning fix: state dropdown regression** — Sidebar edit
  and create forms only listed 6 of 9 canonical states (missing `drafting`,
  `ready`, `merged_pr`) — a regression from #153 that had gone unnoticed. Fixed
  atomically with the sidebar commit per Q4 decision, rather than opening a
  separate follow-up issue.

- **Stricter UI launch gate than backend** — UI requires `state === "ready"`
  AND `can_launch === true`. Backend still accepts `planned` as transitional
  fallback per `execution.service.ts:1267`. Both `buildGraphNodeContextMenu` and
  `handleLaunchExecution` apply this gate; Launch description explains:
  *"Approve the plan first — work item state is X, expected ready."*

## Files Changed

Four atomic commits, +662 / −12 across 6 files:

1. `c099293` `✨🔌 feat(web): add plan lifecycle API helpers`
   - `web/src/lib/api.js` (+33) — `getPlan`, `preparePlan`, `approvePlan`,
     `reopenPlan` helpers.

2. `55aee7c` `✨🧭 feat(graph-node-actions): expose plan actions in context menu`
   - `web/src/lib/graph-node-actions.js` — extended signature with `planState`,
     `planStateLoading`, `preparingPlan`, `approvingPlan`. Added `prepare-plan`,
     `approve-plan`, `review-plan` actions gated by plan sub-state + work item
     state. Stricter launch gate (`state === "ready"`).
   - `src/__tests__/graph-node-actions.test.ts` — new "ADR 014 step 8 — plan
     actions" describe block, +9 tests (prepare/approve/review visibility,
     non-issue kind hiding, launch gate, loading labels, terminal state hiding).

3. `1e36c6b` `✨📋 feat(sidebar): show plan status and plan action buttons`
   - `web/src/components/Sidebar.svelte` (+170/−5) — plan status pill, action
     buttons, `loadPlanStatus`/`refreshPlanStatus` helpers, reactive fetch on
     selection change with request tokens, Launch tooltip/disabled state update.
     **Also** expanded edit + create state dropdowns from 6 → 9 options.

4. `e62d123` `✨🪟 feat(web): wire plan action handlers and review modal`
   - `web/src/App.svelte` (+269/−1) — `planStateById` cache with request tokens,
     `ensurePlanState()` with 404 caching, auto-fetch reactive, handlers for
     prepare/approve/review/close, tightened `handleLaunchExecution`, prefetch
     on context-menu open, plan review modal render block, Escape handler.
   - `web/src/app.css` (~80 lines) — `.plan-status-row`, `.plan-actions`,
     `.plan-review-overlay`, `.plan-review-card`, `.plan-review-header`,
     `.plan-review-body`.

## Quality Gates

- **`npx tsc --noEmit`** — clean
- **`npx vitest run`** — 307/307 green across 21 test files (+9 new
  graph-node-actions tests, was 298)
- **`npx vite build`** — 1.31s clean (only pre-existing a11y warning on
  `PlannerChatAdapter.svelte:720` + unused CSS selector in
  `ExecutionDispatchPanel.svelte:931`, both out of scope)

## Lessons Learned

- **All-backend-already-shipped issues can still produce real regressions.**
  The state dropdown gap in the Sidebar had been silently broken since #153 —
  spotted only because scratchpad-planner's codebase investigation walked every
  place work item `state` was rendered. Worth doing that walk even when an
  issue looks like "just wire a button".

- **Two-call models need defensive caching.** Fetching plan sub-state alongside
  work item state added a per-item cache (`planStateById`) with request tokens
  (`planStateRequestTokenById`) that mirror the existing `launchEligibilityRequestTokenById`
  pattern. Without the request tokens, fast selection changes produced stale
  data flashes.

- **404 is a valid state, not an error.** Planned items legitimately have no
  plan dir yet — `GET /api/plans/:id` returns 404 with "No plan found" as the
  happy path. Caching it as `null` (not leaving `undefined`) prevents infinite
  re-fetching on reactive ticks.

- **First-of-a-kind primitives deserve explicit scaffolding.** The plan review
  modal is the first overlay primitive in the project. Setting `role="presentation"`
  on the outer overlay + `role="dialog" aria-modal="true"` on the card is the
  simplest pattern that satisfies screen readers + click-outside dismissal +
  escape-to-close without pulling in a modal library.

## Out of Scope (deferred)

- Plan history / diff view (superseded plans)
- Plan edit-in-place (the review modal is read-only)
- Run lifecycle surfacing (launched runs still flow through existing execution
  dispatch UI — no changes)
- ADR 014 epic wrap-up / retro doc (this is the final step; a follow-up issue
  could consolidate learnings from all 8 steps)

---

ADR 014 is now complete (8 of 8 steps shipped).
