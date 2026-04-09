# Issue #154 — Studio: extract prepare-plan from execution launch (ADR 014 step 4)

**Archived:** 2026-04-09
**Branch:** `154-extract-prepare-plan-from-execution-launch`
**Code SHA:** `182b45a` (develop at time of archive)
**PR:** [fusupo/escapement-studio#162](https://github.com/fusupo/escapement-studio/pull/162)
**Status:** Merged

## Summary

Introduced a standalone plan preparation operation that drafts or updates the canonical scratchpad for a work item WITHOUT creating a worktree. Extracted the scratchpad-drafting concern out of `ExecutionService.executeRun` so it can stand alone as a pre-execution step with explicit human approval.

By the time `launch` is called, the scratchpad already exists at `plans/<slug>/SCRATCHPAD_<slug>.md` and the work item is in state `ready` (enforced in a later ADR 014 step).

New REST endpoints:
- `POST /api/plans/:work_item_id/prepare` — draft/re-draft scratchpad, `planned → drafting`
- `POST /api/plans/:work_item_id/approve` — `drafting → ready`, auto-refine `predicted_files` from `## Affected Files` section, return diff
- `POST /api/plans/:work_item_id/reopen` — `ready → drafting`, clear approver fields
- `GET  /api/plans/:work_item_id` — fetch metadata + scratchpad content

## Key Decisions

Captured during Phase 3.5 interactive Q&A:

1. **`fetchIssueBody` deduplication** → Extract to `src/lib/github-cli.ts` (single source of truth), refactor `ExecutionService` to import instead of keeping a private copy.
2. **Initial scratchpad content strategy** → Skeleton only (structure + headings + predicted_files seed). No sub-agent call during prepare; drafting is a pure file-write.
3. **Scratchpad content in API responses** → Inline in `PlanResponse.scratchpad_content` so review UIs don't need a second round-trip.

## Files Changed

### New files
- `src/lib/github-cli.ts` — shared gh CLI helper
- `src/modules/plans/plans.service.ts` — lifecycle service (~420 lines)
- `src/modules/plans/plans.controller.ts` — 4 REST endpoints
- `src/modules/plans/plans.module.ts` — NestJS module wiring
- `src/modules/plans/types.ts` — DTOs + `PlanResponse` + `PredictedFilesDiff`
- `src/modules/plans/__tests__/plans.service.test.ts` — 48 tests

### Modified
- `src/lib/context-layout.ts` — expanded `PlanMetadata` from 3-field marker to full 9-field shape; added `planMetadataPath`, `readPlanMetadata`, `writePlanMetadata`; legacy-shape tolerance
- `src/lib/__tests__/context-layout.test.ts` — +6 tests for plan metadata helpers
- `src/modules/execution/execution.service.ts` — removed private `fetchIssueBody`, import from `lib/github-cli.js`
- `src/app.module.ts` — registered `PlansModule`

## Test Results

- `npx tsc --noEmit` — clean
- `npx vitest run` — **225/225** passing (54 new tests added: 6 context-layout + 48 plans.service)
- `npx vite build --config web/vite.config.ts` — clean (only pre-existing a11y warning)

## Lessons Learned

- **Task ordering matters when modules depend on shared libs.** Did Task 3 (extract `fetchIssueBody` to `src/lib/github-cli.ts`) before Task 2 (create PlansService) so the import would resolve cleanly from the first write.
- **State transition ordering in `prepare`.** Transitioned `planned → drafting` BEFORE any file I/O — concurrent prepare requests for the same work item fail fast on the state guard rather than producing two scratchpads.
- **Idempotency via content preservation.** `prepare` carries forward existing non-empty scratchpad content so in-progress edits are never stomped; only regenerates the skeleton for empty/missing files.
- **`approve` with empty Affected Files section preserves `predicted_files`.** When `extractAffectedFiles` returns `[]`, skip the update call entirely. Diff is still computed (`removed = all current`, `unchanged = []`) so the UI shows what would change if the section were populated.
- **LSP phantom diagnostics can linger on refactored files.** Same pattern as #153: trust `tsc --noEmit` (authoritative), ignore LSP cache noise.
- **`Object.create(ServicePrototype)` test harness** cleanly bypasses NestJS DI and makes per-test state isolation trivial — no `Test.createTestingModule` ceremony needed for pure services.

## Out of Scope (deferred to later ADR 014 steps)

- **Step 5** — launch guard that rejects `POST /api/execution/launch` unless `work_item.state === "ready"`
- **Step 7** — run disposition (merge/abandon) and `ready → running` transition wiring
- **UI integration** — Studio frontend wire-up for the new endpoints

---

**Archived by:** archive-work skill v2.2.1 (in-repo mode)
