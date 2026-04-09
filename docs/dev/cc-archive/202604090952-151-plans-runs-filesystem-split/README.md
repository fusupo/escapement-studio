# Issue #151 — Studio: introduce plans/ vs runs/ filesystem split (ADR 014 step 1)

**Archived:** 2026-04-09
**Branch:** studio-151-branch (merged)
**Code SHA:** 5ba17a3
**PR:** [#159](https://github.com/fusupo/escapement-studio/pull/159)
**Status:** Merged

## Summary

Foundational no-op for ADR 014. Introduces the `plans/<slug>/` directory
convention under the context root, centralizes filesystem layout constants
in a single module, and derives stable slugs from work item ids. No
existing behavior changes — subsequent ADR 014 steps (canonical scratchpad
move, state machine expansion, execution integration) will build on this
foundation.

## Key Decisions

- **Helper location:** `src/lib/context-layout.ts` — pure path utility
  shared by multiple modules. Alternative `src/modules/execution/layout.ts`
  was rejected because sub-agents also need it.
- **Collision detection:** At `ensurePlanDir` time (not slug derivation).
  Slug derivation stays pure; collisions are detected by writing a
  `metadata.json` marker in each plan dir and refusing to overwrite when
  a different `work_item_id` already owns the slug.
- **Eager creation:** No — neither `plans/` nor `archives/` are created
  in step 1. The constants exist and path builders return paths, but
  nothing triggers filesystem creation until step 2+ wires in callers.
- **`getWorktreePath` left as `join(this.worktreeRoot, ...)`:** Cannot
  refactor to read from `this.artifactRoot` because the `Object.create`
  test harness in `launch-eligibility.test.ts` bypasses field
  initializers and stubs `worktreeRoot` directly.

## Files Changed

- `src/lib/context-layout.ts` (new) — directory constants
  (`PLANS_DIR`, `RUNS_DIR`, `WORKTREES_DIR`, `ARCHIVES_DIR`,
  `PLAN_METADATA_FILE`), `workItemSlug()`, path builders (`plansRoot`,
  `runsRoot`, `worktreesRoot`, `archivesRoot`, `planDir`, `runDir`,
  `worktreeDir`, `archiveDir`), `ensurePlanDir()` with marker-based
  collision detection
- `src/lib/__tests__/context-layout.test.ts` (new) — 16 unit tests:
  slug derivation (alnum, separators, runs, trim, empty-result error,
  type error), path builders, `ensurePlanDir` (creation, idempotence,
  collision, corrupt marker, empty slug)
- `src/modules/execution/execution.service.ts` — `worktreeRoot` derived
  from `worktreesRoot()`; `artifact_dir` uses `runDir()`
- `src/modules/planning/sub-agent.service.ts` — `artifactDir` uses
  `runDir()` instead of inline `join(artifactRoot, "runs", runId)`

## Quality Checks

- `npx tsc --noEmit` — clean
- `npx vitest run` — 126/126 tests passing (15 files)
- `npx vite build --config web/vite.config.ts` — clean

## Lessons Learned

- The `Object.create(ServicePrototype)` test harness pattern forces
  careful thought about field-initializer refactors: any read of
  `this.foo` that a test stubs directly cannot be replaced with a
  fresh computation from parent fields, because those parent fields
  won't exist in the harness.
- Marker-file collision detection is simpler than an in-memory reverse
  map and survives restarts for free — the filesystem itself is the
  source of truth.
