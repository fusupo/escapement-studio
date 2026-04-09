# Issue #155 — Studio: execution launch consumes approved plan (ADR 014 step 5)

**Archived:** 2026-04-09
**Branch:** `155-execution-launch-consumes-approved-plan`
**Code SHA:** `cf60807` (develop after merge)
**PR:** fusupo/escapement-studio#163 (merged 2026-04-09)
**Status:** Merged

## Summary

Step 5 of the ADR 014 plan/run lifecycle rollout: execution launch now consumes an approved plan instead of synthesizing a scratchpad on the fly. The launch path gates on work-item state, copies the canonical `plans/<slug>/SCRATCHPAD_<slug>.md` into the worktree, skips the setup agent turn when a ready plan exists, appends the new run ID to plan metadata, and exposes manual `in_progress → {ready, drafting}` transitions. A `planned`-only fallback preserves the legacy skeleton-synthesis path until step 4 is broadly deployed.

## Key Decisions (Phase 3.5 Q&A)

1. **Failure classification — manual only.** Both `in_progress → ready` and `in_progress → drafting` are operator-triggered via endpoints. No auto-classification in this step; step 7 (run disposition) can add hooks later.
2. **Fallback scope — `planned` only.** Items in `planned` can still launch (skeleton synthesized, setup phase runs). `drafting` must go through approve first. Keeps the "approved plan" contract sharp.
3. **Setup phase for `ready` plans — skip entirely.** Go straight to do-work. The approved scratchpad IS the executable contract.
4. **`run_ids` append timing — at launch.** Append when the run record is created. Every attempt leaves a trace, even blocked/failed starts. Non-fatal on write failure.

## Files Changed

- `src/modules/execution/execution.service.ts` (+173 / −22)
  - New helpers: `isLaunchableState`, `checkLaunchableState`, `appendRunIdToPlanMetadata`, `transitionInProgressToDrafting`, `syncScratchpadToCanonical`
  - `writeScratchpad()` refactored to return `{ path, source: "canonical_ready" | "carried_forward" | "synthesized" }`
  - `executeRun()` skips the setup phase when `source === "canonical_ready"`
  - `launch()` wires the non-fatal `run_ids` append after `persistRun(run)`
- `src/modules/execution/execution.controller.ts` (+12)
  - Added `POST /api/execution/transition-ready` and `POST /api/execution/transition-drafting`
- `src/modules/execution/types.ts` (+9)
  - New `TransitionWorkItemDto` interface
- `src/modules/execution/__tests__/launch-eligibility.test.ts` (+143)
  - Parametrized `launchable_state` safety-check coverage over all 9 work-item states
  - `transitionInProgressToDrafting` happy-path + rejection tests
  - `vi.fn()` stub for `appendRunIdToPlanMetadata` in the launch harness
- `src/modules/execution/__tests__/scratchpad-canonical.test.ts` (+194)
  - `writeScratchpad` discriminated-source coverage (canonical_ready / carried_forward / synthesized / ready_plan_scratchpad_missing)
  - `appendRunIdToPlanMetadata` idempotency, ordering, missing-metadata, write-failure tolerance

## Quality Gates

- `npx tsc --noEmit` — clean
- `npx vitest run` — 248/248 across 19 files (23 new tests: 13 launch-eligibility + 10 scratchpad-canonical)
- `npx vite build --config web/vite.config.ts` — 1.32 s, only pre-existing unused-CSS warnings

## Lessons Learned

- **LSP phantom diagnostics are not authoritative.** Trust `npx tsc --noEmit`. Several rounds of false positives on `checkLaunchableState`, `readPlanMetadata`, `writePlanMetadata`, `TransitionWorkItemDto`, and `appendRunIdToPlanMetadata` cleared as soon as tsc ran clean.
- **Harness gotcha.** Adding `appendRunIdToPlanMetadata(...)` to `launch()` broke the existing `makeLaunchHarness` tests because the harness didn't wire up `logger`. Fix: stub the new helper with `vi.fn()` so the harness tests stay focused on state transitions and don't need a filesystem-backed plan dir.
- **Discriminated union > boolean flag.** `writeScratchpad` returning `{ path, source }` let `executeRun` branch cleanly on `canonical_ready` and let the tests assert on the exact path the code took, which made the state machine much easier to reason about.
- **Non-fatal metadata writes.** `appendRunIdToPlanMetadata` is wrapped in try/catch with `logger.warn` — a corrupted `plans/<slug>/metadata.json` must never block a run from launching.
