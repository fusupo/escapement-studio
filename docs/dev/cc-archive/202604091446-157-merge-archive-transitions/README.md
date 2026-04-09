# Issue #157 — Studio: open_pr → merged_pr → done transitions (ADR 014 step 7)

**Archived:** 2026-04-09
**Branch:** `157-merge-archive-transitions`
**Code SHA:** `8a16a6c` (merge of PR #165 into `develop`)
**PR:** [fusupo/escapement-studio#165](https://github.com/fusupo/escapement-studio/pull/165)
**Issue:** [fusupo/escapement-studio#157](https://github.com/fusupo/escapement-studio/issues/157)
**Status:** Merged

## Summary

Wired the `merged_pr → done` disposition flow for ADR 014 step 7. Two user-driven actions:

1. **Close** — `merged_pr → done`, no archive created.
2. **Archive and close** — moves `plans/<slug>/` → `archives/<slug>/` via `fs.renameSync`, writes canonical `archive_path`, then transitions to `done`.

Both guard against plan-dir moves while any run for the same work item is active. Also retargeted the existing "Close issue" frontend button to route through the new backend endpoint, closing the last side channel that bypassed the state machine via a raw `PUT { state: "done" }`. Cancelled-path plan-dir move was unified under the same helper.

Merge detection (`open_pr → merged_pr`) already worked — this step implemented the disposition flow that sits downstream of it.

## Key Decisions

- **Q1 — Frontend scope:** Backend + retarget the existing Close button. No new "Archive and close" UI (that's step 8 / #83 territory). The existing button bypassed the state machine via raw `PUT`, which was a latent bug; fixing it was required to close the side channel step 7 exists to eliminate.
- **Q2 — Directory move:** `fs.renameSync`. Atomic within a single filesystem. Context root lives in one tree; cross-device EXDEV is not an expected failure mode.
- **Q3 — `archive_path` population:** Canonical via `archiveDir(artifactRoot, workItemId)`. Ignores caller-supplied values (the DTO passthrough was effectively dead input). Single source of truth; deterministic tests.
- **Q4 — Active-run guard:** In-memory — filter `listRecentRuns()` for `{work_item_id, status ∈ active-set}`. Matches `findRecentRunForSync` / `cleanupAllStale` precedent. On server restart, `recentRuns` is empty so a previously-active run is undetectable. Documented limitation, acceptable for V1.
- **Disposition lives on `ExecutionService`, not a new `DispositionService`:** `ExecutionService` already owns `listRecentRuns()`, already imports `context-layout`, and step 7's surface is only 3 public + 3 private methods — not enough to justify new service + module wiring.
- **Dedicated endpoints, not `VALID_HUMAN_TRANSITIONS`:** `merged_pr → done` has side effects (filesystem move, `archive_path` population). Routing it through the generic human-transition endpoint would require special-casing in the controller mirroring the `in_progress → ready` carve-out. Cleaner to expose dedicated `POST /api/execution/{close-merged, archive-and-close-merged}`.
- **Retry safety:** If the state update fails after a successful `renameSync`, on retry `movePlanDirToArchives` observes `plans/<slug>/` empty, returns `{ moved: false, archive_path: null }`, and state update completes. Retry-safe without transactional writes.

## Files Changed

**Backend (`+596 / −4`):**

- `src/modules/execution/execution.service.ts` — 3 public disposition methods (`closeMergedPullRequest`, `archiveAndCloseMergedPullRequest`, `cancelWorkItem`) + 3 private helpers (`assertWorkItemInMergedPr`, `assertNoActiveRunForWorkItem`, `movePlanDirToArchives`). Guard order: state → active-run → filesystem → state-update (retryable on failure).
- `src/modules/execution/execution.controller.ts` — `POST /api/execution/close-merged` and `POST /api/execution/archive-and-close-merged` endpoints.
- `src/modules/graph/work-items.controller.ts` — `* → cancelled` delegation to `ExecutionService.cancelWorkItem` so the plan-dir move and active-run guard run before any state update.
- `src/modules/execution/__tests__/disposition.test.ts` (new, 385 lines) — 22 tests across 6 describe blocks. Real `mkdtempSync` tmp context roots, `Object.create(ExecutionService.prototype)` harness. Coverage: assertions, helper, endpoints, cancel path, regression guard for `syncMergedPullRequest` still targeting `merged_pr`.
- `src/modules/graph/__tests__/work-item-transitions.test.ts` — added `cancelWorkItem` stub to harness; new "cancelled delegation (ADR 014 step 7)" describe block with 5 parameterized source-state tests.
- `src/__tests__/state-machine-allowlist.test.ts` — comment updated pointing at dedicated endpoints for the `merged_pr` allowlist assertion.

**Frontend (`+38 / −1`):**

- `web/src/lib/api.js` — 3 new helpers: `syncMergedPullRequest`, `closeMergedPullRequest`, `archiveAndCloseMergedPullRequest`.
- `web/src/App.svelte` — `handleCloseIssue` rewritten to call GitHub close → conditional `post-merge-sync` (if not already `merged_pr`/`done`) → `close-merged` (if not already `done`) → refresh graph. Replaces the raw `PUT { state: "done" }` path.

## Quality Gates

- `npx tsc --noEmit` — clean
- `npx vitest run` — **298/298** across 21 test files (was 264; +34 tests: 22 new disposition + 5 cancelled-delegation + scaffolding)
- `npx vite build --config web/vite.config.ts` — 1.34s clean

## Lessons Learned

- **Merge detection was already done.** Agent finding during setup: `syncMergedPullRequest` at `execution.service.ts:436-517` already set state to `merged_pr`, not `done`. The "Done When" item for merge detection was satisfied in step 3. Step 7's real work was the disposition flow downstream. This was captured as a regression guard test (`syncMergedPullRequest still targets merged_pr`) so a future rewrite can't silently break the disposition flow.
- **Guard order matters for retry safety.** State check → active-run check → filesystem → state update. Each guard runs before any mutation, and the filesystem mutation is idempotent on retry (renameSync of a missing source is a warn-no-op). Lets the user retry `archive-and-close` after a transient state-update failure without manual cleanup.
- **The frontend "Close issue" button was a hidden side channel.** It bypassed `VALID_HUMAN_TRANSITIONS` entirely via `updateWorkItem({ state: "done" })`. Closing that channel was not in the original issue scope but was required for step 7 to actually mean anything — any disposition flow is meaningless if there's a raw `PUT` path to the same terminal state. Documented in Q1 as the reason the frontend retarget is in scope.
- **`it.each` shines for parameterized guard coverage.** 6 wrong states × identical assertion became one readable test instead of 6 duplicate blocks. Same for the 4 active-run statuses.

---

**Generated:** 2026-04-09
**By:** archive-work skill (in-repo mode)
