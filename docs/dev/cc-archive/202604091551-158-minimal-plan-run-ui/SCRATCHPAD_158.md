# Scratchpad: studio-158 — Studio: minimal UI exposure for plan/run lifecycle (ADR 014 step 8)

## Issue Details

- **Issue:** https://github.com/fusupo/escapement-studio/issues/158
- **Repo:** fusupo/escapement-studio
- **Branch:** `158-minimal-plan-run-ui` (to be created)
- **Base ref:** `develop` (origin/develop `fcdf103`)
- **ADR:** `docs/adr/014-plans-runs-state-model.md` (step 8 of 8 — final step)
- **Contract:** `docs/contracts/plan-and-run-lifecycle.md`
- **Depends on:** #151–#157 (steps 1–7, all merged)
- **Related:** #83 (disposition epic — archive UI deferred there)

## Summary

Add the smallest useful UI surface for the plan/run split. Three actions (Prepare plan, Approve plan, Review plan) plus an updated Launch gate, exposed in the Sidebar and the graph node context menu. Show plan sub-state (`drafting` / `ready` / `superseded`) alongside work item state. Review plan opens the canonical scratchpad in a full-page modal overlay.

**All backend is already done.** Steps 4–5 shipped the plans endpoints (`POST /api/plans/:id/prepare`, `/approve`, `/reopen`, `GET /api/plans/:id`) and the launch-gated-on-ready flow. This issue is purely a frontend wiring task.

**Scope includes** a trivial fix to the Sidebar state dropdown which currently lists only 6 of 9 canonical states — discovered during planning.

## Acceptance Criteria

- [ ] `web/src/lib/api.js` exposes `getPlan`, `preparePlan`, `approvePlan`, `reopenPlan` helpers matching existing API helper style
- [ ] Sidebar shows a plan status pill (`drafting` / `ready` / `superseded`) next to the work item state card, populated via `GET /api/plans/:id` with a stale-response guard token
- [ ] Sidebar shows a **Prepare plan** button when work item state is `planned` or `drafting` and kind is `issue`; triggers `POST /api/plans/:id/prepare` and refreshes the graph
- [ ] Sidebar shows an **Approve plan** button when plan sub-state is `drafting`; triggers `POST /api/plans/:id/approve` and refreshes both plan and graph
- [ ] Sidebar shows a **Review plan** button when a plan is loaded (`drafting` or `ready`); opens a full-page modal overlay displaying `scratchpad_content` as a scrollable `<pre>`
- [ ] Sidebar Launch button gating adds `selectedItem.state === "ready"` as a required condition (in addition to existing `launchEligibility.can_launch`)
- [ ] Context menu (`buildGraphNodeContextMenu` in `web/src/lib/graph-node-actions.js`) includes Prepare plan / Approve plan / Review plan items, gated by the same conditions as the Sidebar buttons
- [ ] Sidebar edit form state dropdown lists all 9 canonical states: `planned`, `drafting`, `ready`, `in_progress`, `open_pr`, `merged_pr`, `done`, `deferred`, `cancelled`
- [ ] `src/__tests__/graph-node-actions.test.ts` covers the new plan action items in the context menu (visibility, gating by state, action ids)
- [ ] No backend changes (all endpoints already exist)
- [ ] `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config web/vite.config.ts` all pass

## Decisions Made (Phase 3.5 Q&A)

**Q1 — Action surface: Sidebar + context menu.**
Expose Prepare / Approve / Review in both surfaces. The context menu actions thread through `buildGraphNodeContextMenu` (already a pure function with an established test harness), so adding them keeps the surface consistent with existing context menu items and gives us automatic test coverage.

**Q2 — Review modality: Full-page overlay modal.**
Sidebar inline `<details>` is too cramped (~320px wide) for a multi-kilobyte scratchpad. Introduce a single, minimal modal primitive: `position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999` with a centered scrollable card. First modal in the project — kept minimal and self-contained (inline in `App.svelte`, no new component).

**Q3 — Approve plan: Included in this issue.**
Without an Approve button, `drafting → ready` can only happen via raw API or the planner agent — leaves a UX gap that Launch can't close. Small addition in scope; keeps the Prepare → Review → Approve → Launch flow usable end-to-end from the Studio UI alone.

**Q4 — Sidebar state dropdown: Fix in this issue.**
One-line change adding the 3 missing states. Discovered during planning. Leaving it out would mean the raw edit surface continues to misrepresent the state machine, which is worse than shipping the fix atomically with step 8.

## Branch Strategy

- Base: `develop` (origin/develop `fcdf103`)
- Feature branch: `158-minimal-plan-run-ui`

## Implementation Checklist

### Task 1 — Plan API helpers (`web/src/lib/api.js`)

Add four functions following existing helper style (same pattern as `closeMergedPullRequest` etc from #157):

```js
export function getPlan(workItemId) {
  return request(`/api/plans/${encodeURIComponent(workItemId)}`);
}
export function preparePlan(workItemId) {
  return request(`/api/plans/${encodeURIComponent(workItemId)}/prepare`, {
    method: "POST", headers: jsonHeaders, body: "{}",
  });
}
export function approvePlan(workItemId, payload = {}) {
  return request(`/api/plans/${encodeURIComponent(workItemId)}/approve`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify(payload),
  });
}
export function reopenPlan(workItemId, payload = {}) {
  return request(`/api/plans/${encodeURIComponent(workItemId)}/reopen`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify(payload),
  });
}
```

- Files: `web/src/lib/api.js`
- Why first: all subsequent UI tasks depend on these helpers. Clean, isolated commit.
- Tests: none (thin fetch wrappers; coverage comes through Task 5 via `buildGraphNodeContextMenu` action wiring tests).

### Task 2 — Context menu plan actions (`web/src/lib/graph-node-actions.js` + tests)

Extend `buildGraphNodeContextMenu` to accept `planState` and emit plan action items when applicable:

- `prepare_plan` — when `workItemState in {planned, drafting}` and `kind === "issue"`
- `approve_plan` — when `planState?.state === "drafting"`
- `review_plan` — when `planState?.state === "drafting" || planState?.state === "ready"`
- Existing `launch_execution` — add `workItemState === "ready"` to gating alongside the existing `canLaunch` check

Extend `src/__tests__/graph-node-actions.test.ts` with cases covering each new action's visibility, gating, and action id. This is the primary test artifact for this issue since there's no Svelte component test infrastructure.

- Files: `web/src/lib/graph-node-actions.js`, `src/__tests__/graph-node-actions.test.ts`
- Why second: pure function + tests, reviewable in isolation. Lays the ground for wiring in the Svelte layer.
- Verification: `npx vitest run src/__tests__/graph-node-actions.test.ts` green.

### Task 3 — Sidebar plan state tracking (`web/src/components/Sidebar.svelte`)

Add plan state fetching and display:

1. New props (from App.svelte): `onPreparePlan`, `onApprovePlan`, `onReviewPlan`, `preparingPlan`, `approvingPlan`
2. Local state: `planStatus = null`, `planStatusLoading = false`, `planStatusError = null`, `planFetchToken = 0`
3. Reactive fetch: when `selectedItem` changes, if `kind === "issue"` and state is in `{drafting, ready, in_progress, open_pr, merged_pr}`, call `getPlan(selectedItem.id)`. Bump and compare `planFetchToken` on resolve to discard stale responses (same pattern as existing `linkedPrLookupToken`). 404 → `planStatus = null` (no plan yet).
4. Render in Execution card (above the Launch button):
   - Plan status pill when `planStatus?.state` is set — color-coded: `drafting` warn-tone, `ready` healthy-tone, `superseded` muted-tone (reuse existing pill classes from the dispatchable/blocked pill)
   - **Prepare plan** button when `selectedItem.state in {planned, drafting}`
   - **Approve plan** button when `planStatus?.state === "drafting"`
   - **Review plan** button when `planStatus?.state in {drafting, ready}`
5. Launch button: add `|| selectedItem?.state !== "ready"` to the `disabled` condition; add helper text when disabled for state reason.

- Files: `web/src/components/Sidebar.svelte`
- Why third: depends on Task 1 (api helpers). Modifies only the Sidebar; App.svelte handlers come next.

### Task 4 — Sidebar state dropdown fix (`web/src/components/Sidebar.svelte`)

Expand the `<select>` in the edit form to list all 9 canonical states. Trivial change, can be part of the Task 3 commit or separate.

- Files: `web/src/components/Sidebar.svelte`
- Why fourth: part of the same Sidebar edit pass. Document in commit message as discovered-during-planning fix.

### Task 5 — App-level handlers + modal (`web/src/App.svelte`)

1. Import `getPlan`, `preparePlan`, `approvePlan` from `api.js`
2. New state: `preparingPlan = false`, `approvingPlan = false`, `planReview = null` (`{ workItemId, scratchpadContent } | null`)
3. `handlePreparePlan(item)`:
   - Sets `preparingPlan = true`, clears `error`
   - Calls `preparePlan(item.id)`
   - Calls `loadGraph()` to refresh work item state
   - On throw: sets `error`
   - Finally: clears `preparingPlan`
4. `handleApprovePlan(item)`: same shape with `approvePlan(item.id, {})` and `loadGraph()`
5. `handleReviewPlan(item)`:
   - Calls `getPlan(item.id)`
   - Sets `planReview = { workItemId: item.id, scratchpadContent: response.scratchpad_content }`
6. Render modal: `{#if planReview}` block with:
   - Fixed overlay `<div class="modal-overlay">`
   - Centered `<div class="modal-card">` containing title (`Plan for {workItemId}`), close button, scrollable `<pre>{scratchpadContent}</pre>`
   - Click-outside and Escape key dismiss
7. Pass new props down to `Sidebar`
8. Also wire the new context menu actions (from Task 2) to the same handlers when the context menu fires an action — extends the existing `onNodeAction`-style dispatch.

- Files: `web/src/App.svelte`, `web/src/app.css` (modal styles)
- Why fifth: depends on Task 1 (api helpers), Task 2 (context menu action ids), Task 3 (Sidebar props).

### Task 6 — Quality gates

- `npx tsc --noEmit`
- `npx vitest run` (single-threaded per CLAUDE.md constraints)
- `npx vite build --config web/vite.config.ts`

Fix any type errors, lint warnings, or build warnings that surface. Pre-existing warnings on `PlannerChatAdapter.svelte` and `ExecutionDispatchPanel.svelte` (dialog role, unused selector) are NOT in scope — just don't regress.

### Task 7 — Commit + PR

Split into logical commits:

1. `✨ feat(web): add plan API helpers (#158)` — Task 1
2. `✨ feat(graph-node-actions): expose plan actions in context menu (#158)` — Task 2 (code + tests)
3. `✨ feat(sidebar): show plan status and plan action buttons (#158)` — Tasks 3+4
4. `✨ feat(web): wire plan action handlers and review modal (#158)` — Task 5

PR targeting `develop`. Body references ADR 014 step 8 and closes #158.

## Technical Notes

### Plan state is a two-call model

Work item state (`selectedItem.state`) comes from the graph response. Plan sub-state (`drafting` / `ready` / `superseded`) is only available from `GET /api/plans/:id`. The Sidebar does an extra fetch when the selected item is in a state where a plan should exist. Guard against:

- **Stale responses** — token pattern (`planFetchToken`), same as the existing `linkedPrLookupToken`
- **404 for `planned` items** — treated as "no plan yet", clear `planStatus`
- **Non-issue items** — skip the fetch entirely
- **Terminal states** (`done`, `cancelled`, `deferred`) — skip (plan may be archived or irrelevant)

### Launch gating — stricter in UI than backend

The backend still allows `planned` as a transitional fallback per `execution.service.ts:1267`. The UI gate is stricter: requires `selectedItem.state === "ready"`. This pushes users toward the approved-plan flow even though the backend would technically allow a raw `planned` launch. The backend enforces its own server-side gate anyway, so this is UX sugar.

### Modal pattern

No existing modal primitive in the codebase. Adding the first one. Keep it minimal and inline in `App.svelte`:

```svelte
{#if planReview}
  <div class="modal-overlay" on:click={closePlanReview} on:keydown={...} role="dialog">
    <div class="modal-card" on:click|stopPropagation>
      <header>
        <h3>Plan — {planReview.workItemId}</h3>
        <button on:click={closePlanReview}>×</button>
      </header>
      <pre class="scratchpad-body">{planReview.scratchpadContent}</pre>
    </div>
  </div>
{/if}
```

CSS lives in `app.css` under a `/* modal overlay (#158) */` comment block. ~30 lines of CSS total.

### No Svelte component test infra

Per the planner agent's findings: `vitest.config.ts` targets `src/**/__tests__/**/*.test.ts` in a node environment. No browser mode, no Playwright. The testable unit for this issue is `web/src/lib/graph-node-actions.js` (pure function) exercised via `src/__tests__/graph-node-actions.test.ts`. Sidebar and App.svelte changes are verified by build + manual smoke check.

### Approve plan payload

`POST /api/plans/:id/approve` accepts an optional body. From step 4 (#154) the approve endpoint can take reviewer metadata. V1 frontend calls with `{}` — future enhancement could thread through reviewer identity. Document as a follow-up, not scope creep for #158.

## Questions/Blockers

### Clarifications Needed

_(None — all resolved in Phase 3.5 Q&A above.)_

### Blocked By

_(None — all backend endpoints already exist and are merged on `develop`.)_

### Assumptions Made

- `web/src/components/Sidebar.svelte` is currently plain JS Svelte (no `<script lang="ts">`). New props are passed as plain JS props. Confirm on file open.
- The existing pill styles for dispatchable/blocked are reusable for plan state. If not, add new pill classes in `app.css`.
- `request()` helper in `api.js` returns parsed JSON and throws on 4xx/5xx. 404 handling in the Sidebar needs an explicit try/catch.
- The context menu dispatch mechanism (`onNodeAction`) can be extended without breaking the existing Launch/Open wiring.

## Work Log

_(Populated during do-work execution)_

---
**Generated:** 2026-04-09
**By:** setup-work skill
**Source:** https://github.com/fusupo/escapement-studio/issues/158
