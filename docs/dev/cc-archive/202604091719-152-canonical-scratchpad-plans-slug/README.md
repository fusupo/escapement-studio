# Issue #152 - Canonical scratchpad at plans/<slug>/SCRATCHPAD_<slug>.md (ADR 014 step 2)

**Archived:** 2026-04-09
**Branch:** 152-canonical-scratchpad-plans-slug
**Code SHA:** 06527b9
**PR:** [#160](https://github.com/fusupo/escapement-studio/pull/160) (merged 2026-04-09T17:19:02Z)
**Status:** Merged

## Summary

Step 2 of ADR 014. Moved the canonical scratchpad from an inline-generated `SCRATCHPAD.md` in the
worktree to a durable file at `plans/<slug>/SCRATCHPAD_<slug>.md` under the artifact root. During a
run the canonical file is copied into the worktree at launch and synced back at phase boundaries
(end of setup, after feedback-driven plan updates, end of do-work). `scratchpad-initial.md` and
`scratchpad-final.md` were removed — canonical is now the single source of truth and persists
across runs. Prompts were updated to reference `SCRATCHPAD_<slug>.md` explicitly and the
`.gitignore` moved from the literal `SCRATCHPAD.md` entry to the `SCRATCHPAD_*.md` glob.

Depends on #151 (ADR 014 step 1 — `src/lib/context-layout.ts` helpers).

## Key Decisions

From SCRATCHPAD_152.md Phase 3.5 interactive Q&A (2026-04-09):

1. **Worktree filename convention** → `SCRATCHPAD_<slug>.md` everywhere. Consistent with canonical
   filename; gitignore glob covers it cleanly.
2. **First-run vs. re-run seeding** → Carry forward canonical → worktree. If
   `plans/<slug>/SCRATCHPAD_<slug>.md` exists, copy it into the worktree; otherwise build skeleton
   and write canonical. Forward-compatible with ADR 014 step 4 (prepare-plan extraction).
3. **Sync-back missing worktree file** → Log a warning, leave canonical unchanged. Preserves
   last-known-good; surfaces anomalies for debugging without throwing.
4. **`scratchpad-initial.md` / `scratchpad-final.md`** → Remove entirely. Canonical is the single
   source of truth; demoted snapshots add complexity without clear debugging benefit.
5. **`getRunScratchpad` return type** → Drop the `source` discriminant field entirely. Response is
   `{ run_id, content: string | null }`. Frontend only reads `content`, so no frontend changes
   required.

## Files Changed

- `src/lib/context-layout.ts` — added `canonicalScratchpadPath(artifactRoot, workItemId)` pure
  helper.
- `src/lib/__tests__/context-layout.test.ts` — 3 new tests covering the helper.
- `src/modules/execution/execution.service.ts`:
  - `writeScratchpad` rewritten to carry-forward canonical or seed skeleton, copy to worktree as
    `SCRATCHPAD_<slug>.md`; removed the `scratchpad-initial.md` write.
  - New private `syncScratchpadToCanonical(run)` called at end-of-setup, after feedback-driven
    replan, and at end-of-do-work; warns and returns if worktree file missing.
  - Removed the `scratchpad-final.md` write at completion.
  - `buildSetupPrompt`, `buildDoWorkPrompt`, and inline disambiguation feedback prompt reference
    `SCRATCHPAD_<slug>.md` via a local `scratchpadName` variable.
  - `ensureScratchpadIgnored` now adds `SCRATCHPAD_*.md` (glob) instead of the literal entry.
  - `getRunScratchpad` rewritten: canonical → worktree → null; `source` field dropped.
  - `readChecklistFromWorktree` reads the slug-specific filename.
- `src/modules/execution/__tests__/scratchpad-canonical.test.ts` — new. 6 tests using the
  `Object.create(ExecutionService.prototype)` harness pattern: syncScratchpadToCanonical
  present/missing, getRunScratchpad canonical>worktree precedence, worktree fallback, null when
  both absent, null when run not found, and verifies `source` field is absent.
- `.gitignore` — added `SCRATCHPAD_*.md` alongside existing `SCRATCHPAD.md`.

**Stats:** +292 / -39 across 4 files (plus 1 new test file).

## Lessons Learned

- **Carry-forward canonical is the right default.** Treating the plan file as persistent across
  runs (instead of regenerated every launch) makes step 4 (prepare-plan extraction) a trivial
  drop-in — the canonical file becomes whatever the planner wrote, and execution just reads it.
- **Bundle tightly-coupled changes into one commit.** Originally planned 9 atomic commits per the
  scratchpad. Tasks 2-8 touch overlapping code paths (filename rename cascades through prompts,
  phase boundaries, and fallback chains simultaneously), so they were bundled into a single commit.
  Task 1 (the pure `canonicalScratchpadPath` helper) stayed separate since it's independently
  testable.
- **Verify frontend impact before dropping API fields.** Grepping `getRunScratchpad` call sites
  before removing the `source` field confirmed only `.content` was read — zero frontend changes
  needed. Worth the 30s check to avoid a broken UI.
- **Trust `npx tsc --noEmit` over IDE diagnostics.** The LSP repeatedly reported phantom TypeScript
  errors (missing exports, missing methods, implicit `any`) throughout the refactor that `tsc` did
  not reproduce. Running the compiler directly was the source of truth.
- **`Object.create(prototype)` test harness still works with new private methods.** The pattern
  established in 151 (stubbing `artifactRoot` + `logger.warn` fields) extended cleanly to cover
  `syncScratchpadToCanonical` without needing full DI setup.
