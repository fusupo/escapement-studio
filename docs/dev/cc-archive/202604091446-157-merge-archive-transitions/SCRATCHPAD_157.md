# Scratchpad: studio-157 — Studio: open_pr to merged_pr to done transitions (ADR 014 step 7)

## Issue Details

- **Issue:** https://github.com/fusupo/escapement-studio/issues/157
- **Repo:** fusupo/escapement-studio
- **Branch:** `157-merge-archive-transitions`
- **Base ref:** `develop` (origin/develop `b2b7749`)
- **ADR:** `docs/adr/014-plans-runs-state-model.md` (step 7 of 8)
- **Contract:** `docs/contracts/plan-and-run-lifecycle.md` (§ Plan dir disposition, § Close vs Archive and close)
- **Depends on:** #151–#156 (steps 1–6, all merged)
- **Related disposition epic:** #83 (plus #84, #86, #88, #89) — this issue is the backend attach point

## Summary

Wire the `merged_pr → done` disposition flow. Two user-driven actions:

1. **Close** — `merged_pr → done`, no archive created
2. **Archive and close** — move `plans/<slug>/` → `archives/<slug>/`, then `merged_pr → done`

Both guard against plan dir moves while any run for the same work item is active. Also fix the existing "Close issue" frontend button to route through the new backend endpoint instead of the raw `PUT { state: "done" }` that currently bypasses the state machine.

**Important scoping finding:** Merge detection (`open_pr → merged_pr`) **already works**. `ExecutionService.syncMergedPullRequest` at `execution.service.ts:436-517` correctly sets `state: "merged_pr"` (line 464). The "Done When" item for merge detection is already satisfied — step 7's real work is the disposition flow that sits downstream of it.

## Acceptance Criteria

- [ ] Merge detection still transitions `open_pr → merged_pr` (regression guard — already works today, just verify)
- [ ] New endpoint `POST /api/execution/close-merged` — body `{ work_item_id }` — transitions `merged_pr → done` without creating an archive; refuses if state ≠ `merged_pr`; refuses if an active run exists for the work item
- [ ] New endpoint `POST /api/execution/archive-and-close-merged` — body `{ work_item_id }` — moves `plans/<slug>/` → `archives/<slug>/` via `fs.renameSync`, writes `archive_path = archiveDir(artifactRoot, workItemId)` to the work item, transitions `merged_pr → done`; same state + active-run guards
- [ ] Plan dir move is also available on `cancelled` (covered by the same helper; tested)
- [ ] Active-run guard uses `listRecentRuns()` + status filter (`queued|preparing|disambiguating|running`), throws `BadRequestException` with the offending run id
- [ ] If the plan dir doesn't exist when archiving, the archive step is a no-op (warning logged) — the state transition still happens
- [ ] If `archives/<slug>/` already exists, the move refuses with `BadRequestException` (no clobbering)
- [ ] Frontend `Sidebar.svelte` "Close issue" button calls `POST /api/execution/close-merged` (via `api.js`) instead of `PUT /api/work-items/:id { state: "done" }`; the close-issue flow (GitHub API call) stays where it is
- [ ] Agent prompt rule unchanged; no changes to `VALID_HUMAN_TRANSITIONS` (disposition is system-triggered, not human-triggered)
- [ ] Tests cover: close endpoint happy path, archive-and-close happy path (plan dir actually moves on disk), state guard rejection, active-run guard rejection, archive-when-no-plan-dir no-op, archive-clobber rejection, cancelled path plan-dir move
- [ ] `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config web/vite.config.ts` all pass

## Decisions Made (Phase 3.5 Q&A)

**Q1 — Frontend scope: Backend + retarget Close button.**
  Ship the two disposition endpoints and fix the existing "Close issue" button to call the new `close-merged` endpoint. No new "Archive and close" UI button — that's step 8 / #83 territory. Reason: the current button bypasses the state machine entirely via a raw `PUT`, which is a latent bug; not fixing it would leave a side channel to `done` that step 7 explicitly exists to close.

**Q2 — Directory move: `fs.renameSync`.**
  Atomic within a single filesystem. Context root lives in one tree; cross-device EXDEV is not an expected failure mode. Clean failure beats silent non-atomic copy-then-delete.

**Q3 — `archive_path` population: Canonical via `archiveDir()`.**
  At disposition time, write `archive_path = archiveDir(artifactRoot, workItemId)`. Ignore any caller-supplied value (the existing DTO passthrough is effectively dead input). Single source of truth; deterministic tests.

**Q4 — Active-run guard: In-memory, documented limitation.**
  Filter `listRecentRuns()` for `{work_item_id, status in active-set}`. Matches `findRecentRunForSync` / `cleanupAllStale` precedent. Document the restart gap in the scratchpad and an inline comment — on server restart, `recentRuns` is empty so a previously-active run is undetectable. Acceptable for V1; can be hardened later if it bites.

## Branch Strategy

- Base: `develop` (origin/develop `b2b7749`)
- Feature branch: `157-merge-archive-transitions` (created, upstream cleared)

## Implementation Checklist

### Task 1 — Disposition helper core (`ExecutionService`)
- [ ] Add private method `assertNoActiveRunForWorkItem(workItemId: string): void` — filters `this.listRecentRuns()` for `run.work_item_id === workItemId && ["queued","preparing","disambiguating","running"].includes(run.status)`; throws `BadRequestException("cannot_dispose_work_item_active_run: run <id> is <status>")` if found
- [ ] Add private method `assertWorkItemInMergedPr(workItemId: string): WorkItemRecord` — loads the work item via `workItemsService.get(id)`, throws `NotFoundException` if missing, throws `BadRequestException("work_item_not_in_merged_pr: state is <state>")` if `state !== "merged_pr"`. Returns the record.
- [ ] Add private method `movePlanDirToArchives(workItemId: string): { moved: boolean; archive_path: string | null }` — computes `src = planDir(artifactRoot, workItemId)`, `dest = archiveDir(artifactRoot, workItemId)`; if `src` doesn't exist → warn + return `{ moved: false, archive_path: null }`; if `dest` exists → throw `BadRequestException("archive_already_exists: <dest>")`; else `mkdirSync(archivesRoot(...), { recursive: true })` + `renameSync(src, dest)` + return `{ moved: true, archive_path: dest }`
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: the guards and the filesystem move are the load-bearing logic; isolating them into small helpers makes tests trivial and keeps the public methods thin

### Task 2 — `closeMergedPullRequest(workItemId)` service method
- [ ] Public method on `ExecutionService` — signature `closeMergedPullRequest(input: TransitionWorkItemDto): WorkItemRecord`
- [ ] Calls `assertWorkItemInMergedPr(input.work_item_id)` (captures workItem)
- [ ] Calls `assertNoActiveRunForWorkItem(input.work_item_id)`
- [ ] Calls `workItemsService.update(input.work_item_id, { state: "done" })`
- [ ] Returns the updated record
- [ ] Does **not** touch the plan dir (that's the "Close" semantic — archive not created)
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: thin wrapper over the helpers; mirrors the shape of `transitionInProgressToReady` at `execution.service.ts:2037`

### Task 3 — `archiveAndCloseMergedPullRequest(workItemId)` service method
- [ ] Public method — signature `archiveAndCloseMergedPullRequest(input: TransitionWorkItemDto): WorkItemRecord`
- [ ] Calls `assertWorkItemInMergedPr` and `assertNoActiveRunForWorkItem` (guards first, BEFORE touching disk)
- [ ] Calls `movePlanDirToArchives(workItemId)` — may return `{ moved: false }` if plan dir was already gone
- [ ] Calls `workItemsService.update(id, { state: "done", archive_path: result.archive_path ?? existing_archive_path })`
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: the "Archive and close" variant; order matters — guards before filesystem, filesystem before state update (so a failed move doesn't leave the work item in a half-transitioned state)

### Task 4 — Cancelled path plan-dir move
- [ ] Scope question: is there a single cancellation entry point today? Grep for `"cancelled"` in `execution.service.ts` and `work-items.service.ts` to find it. If there's a transition endpoint that sets `state: "cancelled"`, wrap it to call `movePlanDirToArchives` first (guarded by `assertNoActiveRunForWorkItem`)
- [ ] If no such endpoint exists yet, do NOT create one — just ensure `movePlanDirToArchives` is callable from wherever cancellation *will* land
- [ ] Acceptance criterion for this task is "the helper can be invoked on cancelled path" — the actual wiring may be a trivial addition or a no-op depending on what exists
- [ ] Files affected: TBD based on grep
- [ ] Why: the contract table at `plan-and-run-lifecycle.md:237-243` explicitly calls for plan dir archival on `cancelled`, and this is the last issue in ADR 014 before the disposition epic — leaving the hook unwired invites regression

### Task 5 — Controller + DTO
- [ ] Reuse `TransitionWorkItemDto` from `src/modules/execution/types.ts:270-272` — same shape as the step-5 transitions (`{ work_item_id: string }`)
- [ ] Add `POST /api/execution/close-merged` → `execution.service.closeMergedPullRequest`
- [ ] Add `POST /api/execution/archive-and-close-merged` → `execution.service.archiveAndCloseMergedPullRequest`
- [ ] Both match the `transition-ready` / `transition-drafting` shape at `execution.controller.ts:66-74`
- [ ] Files affected: `src/modules/execution/execution.controller.ts`
- [ ] Why: smallest possible surface; DTO already exists; convention already established

### Task 6 — Frontend: retarget Close issue button
- [ ] Add `closeMergedPullRequest(workItemId)` to `web/src/lib/api.js` (matching existing `api.js` pattern)
- [ ] Update `App.svelte:handleCloseIssue` at line 305-318: after the GitHub `closeGitHubIssue` call, replace `updateWorkItem(item.id, { state: "done" })` with `closeMergedPullRequest(item.id)`
- [ ] The `canCloseIssue` guard in `Sidebar.svelte:103-106` already checks `merged_at != null`, so the precondition is close to right — but the work item also needs to be in `merged_pr` state, not just `open_pr` with a merged PR. Either tighten the guard or rely on the backend's `assertWorkItemInMergedPr` rejection
- [ ] No new "Archive and close" button — that's step 8
- [ ] Files affected: `web/src/App.svelte`, `web/src/lib/api.js`
- [ ] Why: today's "Close issue" bypasses the state machine via raw `PUT`; step 7 exists in part to close that side channel

### Task 7 — Tests
- [ ] New test file: `src/modules/execution/__tests__/disposition.test.ts`
- [ ] Use real `mkdtempSync` tmp context root so `planDir` / `archiveDir` / `renameSync` exercise actual filesystem semantics (pattern matches `scratchpad-canonical.test.ts` and `scratchpad-commit-guards.test.ts`)
- [ ] Harness: `Object.create(ExecutionService.prototype)` with stubbed `workItemsService`, `listRecentRuns`, `logger`, `artifactRoot`
- [ ] **Test cases:**
  - `assertWorkItemInMergedPr` — happy path returns record; wrong state throws; missing work item throws `NotFoundException`
  - `assertNoActiveRunForWorkItem` — empty runs list passes; run for different work item passes; active run for this work item throws with run id in message; completed run for this work item passes
  - `movePlanDirToArchives` — seed `plans/<slug>/SCRATCHPAD_<slug>.md` + `metadata.json` via `ensurePlanDir`, call helper, assert `plans/<slug>/` no longer exists and `archives/<slug>/` has the files
  - `movePlanDirToArchives` — plan dir missing → returns `{ moved: false, archive_path: null }`, logs warning, does NOT throw
  - `movePlanDirToArchives` — archive dir already exists → throws `archive_already_exists`
  - `closeMergedPullRequest` — happy path: work item in `merged_pr` + no active runs → state becomes `done`, plan dir is **untouched** (still at `plans/<slug>/`), no archive dir created
  - `closeMergedPullRequest` — work item in `open_pr` → throws `work_item_not_in_merged_pr`
  - `closeMergedPullRequest` — active run → throws `cannot_dispose_work_item_active_run`
  - `archiveAndCloseMergedPullRequest` — happy path: state becomes `done`, plan dir moved to `archives/<slug>/`, `work_item.archive_path` populated with canonical value
  - `archiveAndCloseMergedPullRequest` — guards reject BEFORE filesystem is touched (assert `planDir` still exists after the throw)
  - `archiveAndCloseMergedPullRequest` — no plan dir → state still transitions to `done`, `archive_path` stays at existing value
- [ ] Files affected: `src/modules/execution/__tests__/disposition.test.ts` (new)
- [ ] Why: guards + filesystem moves must be tested against real disk; mocking would hide regex/path bugs

### Task 8 — Update state-machine allowlist test note
- [ ] `src/__tests__/state-machine-allowlist.test.ts:112-118` asserts `VALID_HUMAN_TRANSITIONS.merged_pr` is empty with the "reserved for disposition flow (step 7)" comment
- [ ] Keep the assertion (the allowlist stays empty because disposition is system-triggered, not human-triggered)
- [ ] Update the comment from "reserved for step 7" to something like "merged_pr → done is triggered by the disposition endpoints (POST /api/execution/close-merged, POST /api/execution/archive-and-close-merged), not by human transition"
- [ ] Files affected: `src/__tests__/state-machine-allowlist.test.ts`, possibly `src/modules/graph/__tests__/work-item-transitions.test.ts:118`
- [ ] Why: leaving "reserved for step 7" in the comment after step 7 lands is a papercut

### Task 9 — Verify merge detection regression
- [ ] Add a brief assertion (in the disposition test file or a dedicated one) that `syncMergedPullRequest` still sets `state: "merged_pr"` — not `done`. This protects against a future refactor silently re-introducing the old `open_pr → done` collapse
- [ ] The existing `execution.service.ts:461-463` comment is load-bearing; add a test that fails if someone changes line 464 to `"done"`
- [ ] Files affected: existing or new test file
- [ ] Why: the issue's "Done When" list requires merge detection, and while it already works, a regression would silently bypass the disposition flow entirely

### Quality Gates
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — all suites green, new tests counted
- [ ] `npx vite build --config web/vite.config.ts` clean

## Technical Notes

### Guard order matters

In `archiveAndCloseMergedPullRequest`:
1. State guard (cheap)
2. Active-run guard (cheap)
3. Filesystem move (expensive, partially-reversible)
4. State update (cheap, atomic)

If the state update fails after a successful filesystem move, we're in an inconsistent state (plan dir archived but work item still says `merged_pr`). This is recoverable by retrying the endpoint — the `movePlanDirToArchives` helper will return `{ moved: false }` on the retry (since `plans/<slug>/` is now gone) and the state update will succeed. Document this in a comment.

### `archiveDir` semantics

`archiveDir(artifactRoot, workItemId)` at `context-layout.ts:98-100` is a path helper only. It computes `<artifactRoot>/archives/<workItemSlug>`. Step 7 is the first code to actually *write* to it. The helper already exists; we only need to call it and `renameSync` the plan dir on top.

### Active-run guard restart limitation

`listRecentRuns()` returns `this.recentRuns` which is an in-memory array capped at 16 (`execution.service.ts:60`). On server restart, the array is empty. If a run was interrupted mid-execution and the server restarted, the guard would incorrectly report "no active run" and allow disposition. This is acceptable for V1 because:

1. Disposition only happens from `merged_pr` state, which requires a merged PR, which requires the run to have reached `open_pr` successfully
2. A run that reached `open_pr` is effectively "done" from an execution perspective — the interrupted-mid-run case doesn't apply
3. The #83 disposition epic may add run journaling; for now, document and move on

Add an inline comment at `assertNoActiveRunForWorkItem` explaining this.

### Why not use `VALID_HUMAN_TRANSITIONS`

The contract says `merged_pr → done` is "user-driven" but the **transition** itself is executed by the backend disposition service in response to a button click. The transition is not a plain state-change — it has side effects (filesystem, archive path population). Routing it through `VALID_HUMAN_TRANSITIONS` and the generic transition endpoint would require adding special-case logic for the filesystem move, which would mirror the `in_progress → ready` carve-out at `work-items.controller.ts:78-80`. Cleaner to expose dedicated endpoints.

### Why `ExecutionService` and not a new `DispositionService`

- `ExecutionService` already owns `listRecentRuns`, which the active-run guard needs
- `ExecutionService` already imports `context-layout` (`planDir`, `archiveDir`, `archivesRoot`)
- `ExecutionService` already owns `workItemsService` as a dependency
- Adding a new service would require new module wiring + forwardRef considerations
- Step 7 is 2 methods + 3 helpers — not enough surface area to justify its own service

### Event emission

The step-6 guards emit `scratchpad_commit_blocked` run events. Step 7 operates on work items without a run context (runs are already completed by the time disposition happens), so there is no run to append events to. Dispositions could be logged via `logger.log` instead. No `appendEvent` calls needed.

### Out of scope

- New "Archive and close" UI button — step 8 / #83
- Archive browsing / restoration UI — #83 epic
- Persistent run index that survives restart — future hardening, not a V1 requirement
- Any changes to `VALID_HUMAN_TRANSITIONS` — disposition is system-triggered
- Run disposition / auto-classification of failures — orthogonal concern, see `execution.service.ts:2053` comment
- Archive-on-`deferred` — contract says deferred plans stay in `plans/` with `superseded` status, no archival

## Questions/Blockers

### Clarifications Needed
(none — resolved in Phase 3.5)

### Blocked By
(none — all prerequisite steps merged)

### Assumptions Made
- `fs.renameSync` is sufficient (same-filesystem assumption — context root is a single tree)
- `listRecentRuns()` continues to be the correct pattern for run queries (no DB-backed index is imminent)
- The existing `archive_path` field on `WorkItemRecord` is currently unused / freeform and can be safely repurposed to hold the canonical archive directory path
- The `POST /api/execution/post-merge-sync` endpoint remains the only caller-supplied path to `merged_pr` — no human transition is needed

## Work Log

### 2026-04-09 — Session: implementation

- **Task 1** — Added `renameSync` / `archiveDir` / `archivesRoot` / `planDir` imports to `execution.service.ts`. Implemented three private helpers: `assertWorkItemInMergedPr(id)` (state guard, returns record), `assertNoActiveRunForWorkItem(id)` (filters `listRecentRuns()` for `queued|preparing|disambiguating|running`), `movePlanDirToArchives(id)` (warn-and-no-op when plan dir missing; throws `archive_already_exists` on destination collision; otherwise `mkdirSync(archivesRoot)` + `renameSync`). Documented the in-memory restart-gap limitation inline on `assertNoActiveRunForWorkItem`.
- **Tasks 2 & 3** — Added public methods `closeMergedPullRequest(workItemId)` and `archiveAndCloseMergedPullRequest(workItemId)` on `ExecutionService`. Close variant runs the two guards then transitions; archive-and-close variant runs guards → filesystem move → state update (order matters: failed move leaves work item in `merged_pr` for retry; retried move is a no-op). `archive_path` is populated from the canonical `archiveDir()` or preserved at existing value if the plan dir was already gone.
- **Task 4** — Added `cancelWorkItem(workItemId)` on `ExecutionService` (active-run guard + plan dir move + state update to `cancelled`). Wired the `* → cancelled` delegation in `WorkItemsController.transition` analogous to the existing `in_progress → ready` delegation — the `isValidHumanTransition` source-state check runs upstream.
- **Task 5** — Added `POST /api/execution/close-merged` and `POST /api/execution/archive-and-close-merged` to `ExecutionController`, both reusing the existing `TransitionWorkItemDto { work_item_id }` shape from step 5.
- **Task 6** — Frontend retarget: added `syncMergedPullRequest`, `closeMergedPullRequest`, and `archiveAndCloseMergedPullRequest` to `web/src/lib/api.js`. Rewrote `App.svelte:handleCloseIssue` to close the GitHub issue first, then call `post-merge-sync` (if the work item isn't already `merged_pr`/`done`) to land in `merged_pr`, then call `close-merged` for the final transition. This replaces the raw `PUT { state: "done" }` that bypassed the state machine entirely — the whole point of the frontend piece of step 7.
- **Task 7** — New test file `src/modules/execution/__tests__/disposition.test.ts`, **22 tests** across 6 describe blocks:
  - `assertWorkItemInMergedPr` (3): happy path, wrong-state rejection, `NotFoundException` propagation
  - `assertNoActiveRunForWorkItem` (4 + 4 parameterized): empty, other work item, completed, and each of `queued|preparing|disambiguating|running` via `it.each`
  - `movePlanDirToArchives` (3): happy-path move, warn-no-op when missing, `archive_already_exists` rejection
  - `closeMergedPullRequest` (3 + 6 parameterized): state transition with plan dir untouched, `it.each` across 6 non-`merged_pr` states, active-run rejection
  - `archiveAndCloseMergedPullRequest` (4): happy path, no-plan-dir still transitions, state guard before filesystem, active-run guard before filesystem
  - `cancelWorkItem` (3): plan dir moved + state transition, no-plan-dir case, active-run rejection before filesystem
  - Regression guard documentation test for `syncMergedPullRequest` targeting `merged_pr` not `done`
  - Real `mkdtempSync` tmp context roots, `Object.create(ExecutionService.prototype)` harness matching `scratchpad-canonical.test.ts` / `scratchpad-commit-guards.test.ts`
- **Task 8** — Updated the "reserved for step 7" comments in `src/__tests__/state-machine-allowlist.test.ts` and `src/modules/graph/__tests__/work-item-transitions.test.ts` to point at the dedicated disposition endpoints. Also added a new describe block in `work-item-transitions.test.ts` that asserts `* → cancelled` delegates to `ExecutionService.cancelWorkItem` (5 source states). Updated the test harness to provide a `cancelWorkItem` stub.
- **Task 9** — Regression assertion included in the disposition test file (documentation-style — pins the expected post-merge state to `merged_pr` so a future refactor back to `done` would fail the test).
- **Quality gates** — all clean:
  - `npx tsc --noEmit` — clean
  - `npx vitest run` — **298/298** across 21 files (was 264 before step 7; +34 tests: 22 new disposition + 5 new cancelled-delegation + scaffolding)
  - `npx vite build --config web/vite.config.ts` — 1.34 s, only pre-existing a11y/CSS warnings

### Notes

- LSP reported phantom diagnostics throughout the implementation (`renameSync`/`archiveDir`/`archivesRoot`/`planDir` "declared but not read" before the methods using them were added, and a pre-existing `id` unused-parameter at `work-item-transitions.test.ts:46`). All cleared against `npx tsc --noEmit`, which is authoritative.
- **Intentional: the archive-and-close retry story.** If `workItemsService.update` fails *after* a successful `renameSync`, the work item stays in `merged_pr` but the plan dir is already at `archives/<slug>/`. On retry, `movePlanDirToArchives` sees the empty `plans/<slug>/` (returns `{ moved: false, archive_path: null }`), and the state update proceeds with `archive_path` preserved at its previous value. Net effect: retry is safe even though the two writes are not transactional.
- **Frontend handler guard.** The `handleCloseIssue` changes check `item.state !== "merged_pr" && item.state !== "done"` before calling `post-merge-sync`, and `item.state !== "done"` before calling `close-merged`. This handles the rare case where the user double-clicks or the work item was already synced elsewhere. Defense in depth against duplicate API calls.
- Did NOT change `VALID_HUMAN_TRANSITIONS` — `merged_pr → done` stays empty on the allowlist because it's system-triggered via the dedicated endpoints, not via the generic transition endpoint.

### Status

- All implementation tasks complete
- Quality checks: passed
- Ready for commit + PR

---
**Generated:** 2026-04-09
**By:** setup-work skill
**Source:** https://github.com/fusupo/escapement-studio/issues/157
