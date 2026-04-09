# Scratchpad: studio-155 — Studio: execution launch consumes approved plan (ADR 014 step 5)

## Issue Details

- **Issue:** https://github.com/fusupo/escapement-studio/issues/155
- **Repo:** fusupo/escapement-studio
- **Branch:** `155-execution-launch-consumes-approved-plan`
- **Base ref:** develop (local SHA `79cdcdf`, 8 commits ahead of origin/develop)
- **ADR:** `docs/adr/014-plans-runs-state-model.md` (step 5 of 8)
- **Contract:** `docs/contracts/plan-and-run-lifecycle.md`
- **Depends on:** #151 (merged), #152 (merged), #153 (merged), #154 / PR #162 (merged)

## Description

Change execution launch so it requires a `ready` plan, reads the canonical scratchpad from `plans/<slug>/`, copies it into the worktree, and syncs it back on phase boundaries and on completion. Extract the inline setup-phase scratchpad synthesis that is now redundant when a prepared plan exists, keeping a fallback for `planned` items until step 4 is broadly rolled out.

## Acceptance Criteria

- [ ] `launch()` rejects work items not in `ready` state with a clear `not_ready` safety check code (surfaced in eligibility preview and at launch time)
- [ ] Fallback allows `planned` items to launch (skeleton synthesis + setup phase run); `drafting`, `in_progress`, and terminal states are blocked
- [ ] On successful launch from `ready`, the work item transitions `ready → in_progress`
- [ ] `writeScratchpad()` copies `plans/<slug>/SCRATCHPAD_<slug>.md` into the worktree when the plan state is `ready`
- [ ] `writeScratchpad()` throws `ready_plan_scratchpad_missing` if plan is marked `ready` but the canonical file is absent (defensive; eligibility check should catch this upstream)
- [ ] When a `ready` plan is loaded, the setup phase agent turn is **skipped entirely** (straight to do-work)
- [ ] Worktree scratchpad is synced back to canonical at: end of setup phase (fallback only), after additional-context refinement, end of do-work phase, end of follow-up turns
- [ ] `transitionInProgressToDrafting()` method exists as a mirror of `transitionInProgressToReady()`
- [ ] `POST /api/execution/transition-ready` and `POST /api/execution/transition-drafting` endpoints expose both transitions
- [ ] Plan metadata `run_ids` is appended with the new run ID at launch time (non-fatal on write failure)
- [ ] Tests cover: launch gating (ready allowed, planned fallback, others blocked), copy-in from canonical, sync-back to canonical, `in_progress → ready` and `in_progress → drafting` transitions
- [ ] `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config web/vite.config.ts` all pass

## Decisions Made (Phase 3.5 Q&A)

**Q1 — Failure classification:** Manual only.
  **Rationale:** Both `in_progress → ready` and `in_progress → drafting` are operator-triggered via endpoints. No auto-classification in step 5. Step 7 (run disposition) can add hooks later.

**Q2 — Fallback scope:** `planned` only.
  **Rationale:** Items in `planned` state can still launch (skeleton synthesized, setup phase runs). `drafting` must go through approve first. Keeps the "approved plan" contract sharp.

**Q3 — Setup phase for `ready` plans:** Skip entirely.
  **Rationale:** Go straight to do-work. Matches contract intent — the approved scratchpad IS the executable contract.

**Q4 — `run_ids` append timing:** At launch.
  **Rationale:** Append when the run record is created. Every attempt leaves a trace, even blocked/failed starts.

## Branch Strategy

- Base: `develop` (local HEAD at `79cdcdf`)
- Feature branch: `155-execution-launch-consumes-approved-plan`

---

## Implementation Checklist

### Task 1 — Add `not_ready` safety check; gate launch on `ready` (with `planned` fallback)

**Files:** `src/modules/execution/execution.service.ts`

**Why:** The core ADR 014 step 5 requirement. `resolveLaunchEligibility()` and `markWorkItemInProgressOnLaunch()` currently treat `planned` and `ready` identically. After this task, items that are not `ready` (and not `planned` under the fallback) produce a `not_ready` safety check failure that blocks launch. Decision: fallback = `planned` only.

**Changes:**
- Add a helper `isLaunchableState(state: WorkItemState): boolean` returning `true` for `"ready"` and `"planned"` (fallback)
- In `resolveLaunchEligibility()`: add a new `ExecutionSafetyCheck` entry that fails with `code: "not_ready"` when `!isLaunchableState(workItem.state)`. Include a message naming the actual state and the required `ready`/`planned` set.
- Update `markWorkItemInProgressOnLaunch()` to use the same helper and comment the `planned` fallback clearly as step-4-rollout-transitional.
- The safety check should appear in the safety checks array in dispatch previews so operators see why a dispatch is blocked.

**Verification:** `npx tsc --noEmit` passes; existing `launch-eligibility.test.ts` tests continue to pass; new tests in Task 7 cover the gate.

---

### Task 2 — Copy-in canonical scratchpad; skip inline synthesis for `ready` plans

**Files:** `src/modules/execution/execution.service.ts`

**Why:** `writeScratchpad()` currently generates a fresh skeleton via `buildScratchpad()` when the canonical file is absent. After step 4 (just merged), `ready` items always have a canonical file. This task makes the method plan-state-aware: when the plan metadata says `state: "ready"`, the canonical file must exist and is copied in; `buildScratchpad()` is NOT called. The fallback path (no plan dir, or plan state is null/drafting — for `planned` items) continues to generate a skeleton.

**Changes in `writeScratchpad()`:**
- After `ensurePlanDir()`, call `readPlanMetadata()` to check the plan state
- If `metadata?.state === "ready"` and canonical path does not exist: throw `BadRequestException` with code `"ready_plan_scratchpad_missing"` (defensive — Task 1's eligibility check should have caught this)
- If `metadata?.state === "ready"` and canonical path exists: copy to worktree and return `{ path, source: "canonical_ready" }`
- Otherwise: existing skeleton-generation behavior, return `{ path, source: "synthesized" }`

**Return type:** Discriminated result `{ path: string; source: "canonical_ready" | "synthesized" | "carried_forward" }` so `executeRun()` can gate the setup phase.

**Verification:** `npx tsc --noEmit`; new unit tests in Task 7 cover both paths.

---

### Task 3 — Skip setup phase when `writeScratchpad` returns `canonical_ready`

**Files:** `src/modules/execution/execution.service.ts`

**Why:** When the plan is `ready`, the approved scratchpad is the executable contract. The setup-phase agent turn (which re-analyzes and re-writes the plan) is redundant and should be skipped entirely. Fallback `planned` items still run the full setup phase.

**Changes in `executeRun()`:**
- Capture the `writeScratchpad()` result as `scratchpadSource`
- Compute `shouldRunSetupPhase = scratchpadSource !== "canonical_ready"`
- Wrap the existing setup-phase block in `if (shouldRunSetupPhase) { ... }` (currently gated on `disambiguate` — AND the two conditions)
- When skipped, emit an activity log entry: `"Approved plan loaded from canonical — skipping setup phase."` and jump straight to the do-work prompt
- The `ensureScratchpadIgnored()` call stays (ADR 014 step 6 handles its removal)

**Verification:** `npx tsc --noEmit`; ensure logs show the skip message during a `ready`-path test.

---

### Task 4 — Record run ID in plan metadata at launch

**Files:** `src/modules/execution/execution.service.ts`

**Why:** The plan metadata has a `run_ids: string[]` field per the contract. Nothing currently writes to it when a run starts. This creates a traceable link from plan to its runs. Decision Q4: append at launch time (every attempt is traced).

**Changes:**
- Add a private helper `appendRunIdToPlanMetadata(workItemId: string, runId: string): void` on `ExecutionService`
- Call it from `launch()` immediately after the run record is persisted (before the async `executeRun` fires)
- Implementation: `readPlanMetadata` → if absent, no-op; if present, dedupe and push `runId` to `run_ids`, then `writePlanMetadata` with bumped `updated_at`
- Wrap the entire call in try/catch — log a warning on failure, never throw (metadata corruption must not block the run)

**Verification:** `npx tsc --noEmit`; new test asserts metadata `run_ids` is updated after a simulated launch.

---

### Task 5 — Add `transitionInProgressToDrafting()` method

**Files:** `src/modules/execution/execution.service.ts`

**Why:** The contract table has `in_progress → drafting` as the "plan needs rework" failure return path, but no method exists for it. `transitionInProgressToReady()` exists as the symmetrical "plan still valid" path. Decision Q1: both transitions are manual only.

**Changes:**
- Add `transitionInProgressToDrafting(workItemId: string): WorkItemRecord`
- Guard: throw `BadRequestException` if `state !== "in_progress"`
- Body: `this.workItemsService.update(workItemId, { state: "drafting" })` and return the updated record
- Mirror the logging style of `transitionInProgressToReady()`

**Verification:** `npx tsc --noEmit`; new tests in Task 7 cover happy path and guard.

---

### Task 6 — Expose transition endpoints in `ExecutionController`

**Files:** `src/modules/execution/execution.controller.ts`, `src/modules/execution/types.ts`

**Why:** `transitionInProgressToReady()` exists but has no HTTP endpoint. `transitionInProgressToDrafting()` (Task 5) also needs one. Operators need to call these endpoints after run failure/abandonment to advance the state machine.

**Changes:**
- `POST /api/execution/transition-ready` body `{ work_item_id: string }` → calls `transitionInProgressToReady()` → returns the updated `WorkItemRecord`
- `POST /api/execution/transition-drafting` body `{ work_item_id: string }` → calls `transitionInProgressToDrafting()` → returns the updated `WorkItemRecord`
- Add a `TransitionWorkItemDto` interface to `types.ts` (or reuse an existing shape if one exists)
- Match the existing flat `/api/execution/*` endpoint style (consistent with `cleanup`, `follow-up`, `resolve-disambiguation`)

**Verification:** `npx tsc --noEmit`; manual verification of the endpoints during the test plan.

---

### Task 7 — Sync scratchpad back after follow-up turns

**Files:** `src/modules/execution/execution.service.ts`

**Why:** `syncScratchpadToCanonical()` is called at end of setup phase, after additional-context refinement, and at end of do-work phase — but NOT after `executeFollowUpTurn()`. If the agent edits the scratchpad during a follow-up, those edits are lost from canonical. Decision Q5: sync after every follow-up turn (simplest, matches contract wording).

**Changes:**
- After `await session.prompt(message)` in `executeFollowUpTurn()`, call `this.syncScratchpadToCanonical(run)` (logs warning if worktree file missing)

**Verification:** `npx tsc --noEmit`.

---

### Task 8 — Tests: launch gating, copy-in, sync-back, failure return paths

**Files:**
- `src/modules/execution/__tests__/launch-eligibility.test.ts` (extend)
- `src/modules/execution/__tests__/scratchpad-canonical.test.ts` (extend)
- `src/modules/execution/__tests__/transition-states.test.ts` (new)

**Why:** The "Done When" criterion explicitly requires tests for launch gating, copy-in/sync-back, and failure return paths.

**New test cases in `launch-eligibility.test.ts`:**
- "blocks launch for non-launchable states" — parametrized over `drafting`, `in_progress`, `open_pr`, `merged_pr`, `done`, `deferred`, `cancelled` → each produces `not_ready` safety check failure
- "allows launch for `ready` work items" (new/extended assertion)
- "allows launch for `planned` work items under fallback" (new assertion)
- "blocked launches for non-launchable items do not update work item state"

**New test cases in `scratchpad-canonical.test.ts`:**
- `writeScratchpad` with `ready` plan + existing canonical → seeds worktree from canonical, returns `source: "canonical_ready"`
- `writeScratchpad` with `ready` plan but missing canonical → throws `BadRequestException("ready_plan_scratchpad_missing")`
- `writeScratchpad` with no plan dir / null state → generates skeleton, returns `source: "synthesized"`
- `appendRunIdToPlanMetadata` — happy path appends, is idempotent (no duplicates), no-op when metadata missing, swallows write errors

**New file `transition-states.test.ts`:**
- Harness uses `Object.create(ExecutionService.prototype)` pattern with injected `workItemsService`
- `transitionInProgressToReady` — happy path `in_progress → ready`; throws from `planned`, `ready`, `drafting`
- `transitionInProgressToDrafting` — happy path `in_progress → drafting`; throws from `planned`, `ready`, `drafting`

**Verification:** `npx vitest run` passes; full suite green.

---

### Quality Checks

- [ ] `npx tsc --noEmit` (clean)
- [ ] `npx vitest run` (all tests green, new tests exercise each task)
- [ ] `npx vite build --config web/vite.config.ts` (no new warnings)
- [ ] Self-review for code quality
- [ ] Verify all acceptance criteria met

### Documentation

- [ ] No README/docs changes needed (internal refactor + new endpoints; ADR and contract already describe the step)

---

## Technical Notes

### Architecture Considerations

- **Where the `ready` gate lives:** In `resolveLaunchEligibility()` as a `SafetyCheck`, NOT as a pre-flight guard. This makes the block reason visible in dispatch previews, consistent with how `not_dispatchable` works today.
- **`markWorkItemInProgressOnLaunch()` stays as a second line of defense** — the safety check should catch the non-launchable case first, but the method should still validate in case a caller bypasses the eligibility check.
- **`writeScratchpad()` return discriminant** lets `executeRun()` gate the setup phase without re-reading the plan metadata or the canonical file.
- **Plan metadata vs. work item state:** The plan metadata `state` is the authoritative check for "is this plan approved." Work item state is the authoritative check for "is this work item allowed to launch." Both must agree in the happy path. In `writeScratchpad()`, check the plan metadata state (because we're already holding the metadata object). In the safety check, check the work item state (because that's the user-facing gate).

### Implementation Approach

- Tasks 1–3 are the primary refactor. Tasks 4–7 are additive. Task 8 is tests.
- Task ordering: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Each task builds on the previous one.
- Tasks 1 and 2 can each be their own commit; tasks 3 and 7 are small enough to bundle with task 2 or to go together. Prefer separate commits where each tells a coherent story.
- Commit plan (tentative, may bundle during execution):
  1. `feat(execution): gate launch on ready state with planned fallback`
  2. `feat(execution): copy canonical scratchpad into worktree for ready plans`
  3. `feat(execution): skip setup phase when approved plan is loaded`
  4. `feat(execution): record run ID in plan metadata at launch`
  5. `feat(execution): add transitionInProgressToDrafting and expose transition endpoints`
  6. `feat(execution): sync scratchpad back after follow-up turns`
  7. `test(execution): cover ADR 014 step 5 launch gating and transitions`

### Potential Challenges

- **Existing test harnesses in `launch-eligibility.test.ts` and `scratchpad-canonical.test.ts`** may make assumptions that conflict with the new state gate or the discriminated return type. Need to update existing test fixtures carefully to use `state: "ready"` where they currently use `state: "planned"`.
- **`buildSetupPrompt()` and `buildScratchpad()` remain as dead code for the fallback path.** Resist the urge to delete them — they're needed until step 4 is broadly rolled out.
- **Plan metadata write failures** in `appendRunIdToPlanMetadata()` must be non-fatal. Wrap the whole call in try/catch with a logger warning.
- **Concurrency:** two concurrent launches for the same work item could both pass the eligibility check before either calls `markWorkItemInProgressOnLaunch()`. Task 1's guard in that method catches the race (only one can transition `ready → in_progress`, the other throws). Verify this race is still covered by existing tests.

### Out of Scope (deferred to later ADR 014 steps)

- **Step 6** — Commit safety hardening (replacing `ensureScratchpadIgnored()` with hard validation)
- **Step 7** — Run disposition (merge/abandon) and automatic `in_progress → ready`/`drafting` classification
- **UI integration** — Studio frontend wire-up for the new transition endpoints and the `not_ready` safety check display

## Questions / Blockers

### Clarifications Needed

(All resolved via Phase 3.5 Q&A — see "Decisions Made" above.)

### Blocked By

(None — all prerequisite issues #151–#154 are merged.)

## Work Log

_(populated during execution)_

---

**Generated:** 2026-04-09 12:15 by setup-work skill
**Source:** https://github.com/fusupo/escapement-studio/issues/155
