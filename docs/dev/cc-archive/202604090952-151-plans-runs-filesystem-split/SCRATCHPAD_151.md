# Scratchpad: studio-151 — Studio: introduce plans/ vs runs/ filesystem split (ADR 014 step 1)

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/151
- **Branch:** studio-151-branch
- **Base ref:** develop
- **Scope hint:** Introduce `plans/<slug>/` directory convention in the context root, add stable slug derivation from work item ids, and centralize filesystem layout constants. No behavior change.
- **Created:** 2026-04-09

## File Ownership

### Owned
- `src/lib/context-layout.ts` (new)
- `src/lib/__tests__/context-layout.test.ts` (new)
- `src/modules/execution/execution.service.ts`
- `src/modules/planning/sub-agent.service.ts`

### Shared
- (none)

### Forbidden
- `docs/adr/014-plans-runs-state-model.md` (reference only)
- `docs/contracts/plan-and-run-lifecycle.md` (reference only)
- `docs/contracts/run-artifacts.md`
- `docs/contracts/github-sync.md`
- `web/src/**`
- `src/modules/graph`
- `src/modules/github`
- `src/modules/planning/planning.service.ts`
- `src/modules/planning/context.service.ts`
- `src/modules/settings`

## Summary

ADR 014 separates plans from runs as distinct first-class entities. Step 1 is the foundational filesystem reorganization: introduce `plans/<slug>/` under the context root, centralize layout constants, and derive stable slugs from work item ids. This step is intentionally a no-op — no existing behavior changes. Subsequent ADR 014 steps (canonical scratchpad move, state machine expansion, execution integration) will build on this foundation.

The current state has:
- `src/config.ts` defines `artifactRoot` (default `/home/marc/escapement-studio-ctx`)
- `src/modules/execution/execution.service.ts` hardcodes `join(this.artifactRoot, "worktrees")` and `join(this.artifactRoot, "runs", runId)`
- `src/modules/planning/sub-agent.service.ts` hardcodes `join(this.artifactRoot, "runs", runId)` for specialist runs
- No centralized constants, no slug derivation, no `plans/` or `archives/` dirs

After this step, layout paths come from a single helper module in `src/lib/context-layout.ts` that exports constants, slug derivation, and path builders. The execution and sub-agent services reference that helper instead of inlining path joins. `plans/<slug>/` can be created from a work item id without errors, and `archives/` exists as a stub for the disposition epic (#83).

## Acceptance Criteria
- [x] Slug derivation helper exists with unit tests covering: alphanumeric unchanged, non-alphanumeric → `_`, collapse runs of separators, trim leading/trailing separators, and collision detection with explicit error
- [x] Filesystem layout constants are centralized in `src/lib/context-layout.ts` and referenced from `execution.service.ts` and `sub-agent.service.ts`
- [x] A `plans/<slug>/` directory can be created from a work item id via the helper without errors
- [x] `archives/` directory stub exists as a centralized constant (not yet populated)
- [x] No behavior change to existing runs, scratchpads, or execution flow
- [x] TypeScript compilation passes (`npm run check`)
- [x] Tests pass (targeted new slug-helper tests plus existing execution tests)

## Implementation Plan

### 1. Create `src/lib/context-layout.ts`

Exports:

```ts
// Directory name constants
export const PLANS_DIR = "plans";
export const RUNS_DIR = "runs";
export const WORKTREES_DIR = "worktrees";
export const ARCHIVES_DIR = "archives";

// Slug derivation
export function workItemSlug(workItemId: string): string;

// Path builders (pure functions, do not touch fs)
export function plansRoot(artifactRoot: string): string;
export function runsRoot(artifactRoot: string): string;
export function worktreesRoot(artifactRoot: string): string;
export function archivesRoot(artifactRoot: string): string;

export function planDir(artifactRoot: string, workItemId: string): string;
export function runDir(artifactRoot: string, runId: string): string;
export function worktreeDir(artifactRoot: string, branch: string): string;
export function archiveDir(artifactRoot: string, workItemId: string): string;

// fs helpers (create dirs, collision detection)
export function ensurePlanDir(artifactRoot: string, workItemId: string): string;
// Throws if a different work item id maps to the same slug and that plan dir
// already exists. (Collision detection is via a small in-memory reverse map
// of slug → work_item_id, seeded from the plans dir on demand.)
```

**Slug derivation rules** (from the ADR):
1. Replace every non-alphanumeric character with `_`
2. Collapse runs of `_` to a single `_`
3. Trim leading/trailing `_`
4. Throw a clear error if the result is empty

**Collision detection**: `ensurePlanDir` scans the existing `plans/` dir once per call (or caches the result), builds a slug → source-work-item map via a `metadata.json` sidecar or an inline `.work_item` marker file, and refuses to create a plan dir when another work item already owns that slug. For step 1 we use the simplest approach: write a small `metadata.json` in each plan dir at creation time containing `{ work_item_id, created_at }`, and before creating a dir for a given work item, read any existing `metadata.json` at that slug path and refuse if `work_item_id` differs.

### 2. Add unit tests `src/lib/__tests__/context-layout.test.ts`

Test cases:
- `workItemSlug("studio-1234")` → `"studio_1234"`
- `workItemSlug("Studio Foo")` → `"Studio_Foo"`
- `workItemSlug("foo---bar")` → `"foo_bar"` (collapse runs)
- `workItemSlug("__foo__")` → `"foo"` (trim)
- `workItemSlug("/foo/bar/")` → `"foo_bar"`
- `workItemSlug("!!!")` → throws (empty result)
- `workItemSlug("")` → throws
- Path builders produce the expected `plans/<slug>/`, `runs/<id>/`, `archives/<slug>/` joins
- `ensurePlanDir` creates a dir for a fresh work item id, is idempotent when called twice for the same work item id, and throws on collision (another work item id already owns that slug)

### 3. Refactor `execution.service.ts`

- Import `WORKTREES_DIR`, `RUNS_DIR`, `runDir`, `worktreeDir` from `src/lib/context-layout.ts`
- Replace `this.worktreeRoot = join(this.artifactRoot, "worktrees")` with `worktreesRoot(this.artifactRoot)` or use `worktreeDir` at call sites
- Replace `join(this.artifactRoot, "runs", runId)` with `runDir(this.artifactRoot, runId)`
- Verify `boundedRoot = resolve(this.worktreeRoot)` (line 1211) still works
- Verify worktree resolution (line 1946) still works

### 4. Refactor `sub-agent.service.ts`

- Same pattern: replace the hardcoded `join(this.artifactRoot, "runs", runId)` with `runDir(this.artifactRoot, runId)`

### 5. Quality checks

- `npm run check` (TypeScript)
- `npx vitest run src/lib/__tests__/context-layout.test.ts` (new tests)
- `npx vitest run src/modules/execution/__tests__` (existing execution tests still pass)
- `npm run build:web` (frontend still builds — should be unaffected)

## Affected Files
- `src/lib/context-layout.ts` (new) — constants, slug derivation, path builders, `ensurePlanDir` helper with collision detection
- `src/lib/__tests__/context-layout.test.ts` (new) — unit tests for slug derivation and collision detection
- `src/modules/execution/execution.service.ts` — replace inline path joins with helpers from `context-layout.ts`; `worktreeRoot` and `runDir` calls
- `src/modules/planning/sub-agent.service.ts` — replace inline `runs/<run_id>` join with `runDir` helper

## Quality Checks
- [x] TypeScript compilation passes (`npx tsc --noEmit`)
- [x] New slug/layout tests pass (16 tests in `src/lib/__tests__/context-layout.test.ts`)
- [x] Existing execution tests pass (`npx vitest run src/modules/execution/__tests__`)
- [x] Full test suite passes (126/126 tests across 15 files)
- [x] Frontend build still succeeds (`npx vite build --config web/vite.config.ts`)
- [ ] Sanity check: launching an execution run from the Studio UI still produces a worktree and a `runs/<run_id>/` directory (manual check after merge)

## Questions / Concerns
- **Collision detection scope**: The issue says "collision detection with explicit error" but the ADR doesn't specify where collisions get detected (at slug derivation time, at plan dir creation time, or both). I'm treating slug derivation as pure (it can produce the same slug for different inputs legitimately — that's fine) and detecting collisions at `ensurePlanDir` time by writing a `metadata.json` marker. This matches the ADR's plan metadata schema (`plan_id`, `work_item_id`, `state`, etc.) but only uses a minimal subset for step 1. Full plan metadata is out of scope until step 2+.
- **Where to put the helper**: `src/lib/context-layout.ts` feels right since it's a pure path utility shared by multiple modules. Alternative would be `src/modules/execution/layout.ts` but that makes execution own something sub-agents also need. I'm going with `src/lib/`.
- **Should `plans/` be created eagerly?** No — step 1 is explicitly a no-op. The `plans/` dir only gets created on first `ensurePlanDir` call, which nothing calls yet. The directory convention and helper exist, but no code path triggers creation in step 1. Step 2+ will wire in callers.
- **Should `archives/` be created eagerly?** Same reasoning — no. The constant exists and `archivesRoot()` returns the path, but nothing creates it until the disposition epic needs it.

## Work Log

### 2026-04-09 — Setup
- Created branch `studio-151-branch` from `develop`
- Read ADR 014 and `docs/contracts/plan-and-run-lifecycle.md` to understand the target filesystem layout and slug rules
- Traced existing filesystem constants in `src/config.ts`, `src/modules/execution/execution.service.ts`, and `src/modules/planning/sub-agent.service.ts`
- Confirmed `src/lib/` exists and is a suitable location for the shared helper
- Drafted implementation plan and file ownership

### 2026-04-09 — Implementation
- Created `src/lib/context-layout.ts` with directory constants (`PLANS_DIR`, `RUNS_DIR`, `WORKTREES_DIR`, `ARCHIVES_DIR`, `PLAN_METADATA_FILE`), `workItemSlug()` helper, path builders (`plansRoot`, `runsRoot`, `worktreesRoot`, `archivesRoot`, `planDir`, `runDir`, `worktreeDir`, `archiveDir`), and `ensurePlanDir()` with marker-based collision detection
- Added `src/lib/__tests__/context-layout.test.ts` with 16 unit tests covering slug derivation (alnum, separators, runs, trim, empty-result error, type error), path builders, and `ensurePlanDir` (creation, idempotence, collision detection, corrupt marker, empty slug)
- Refactored `src/modules/execution/execution.service.ts`: `worktreeRoot` now derived from `worktreesRoot()`; `artifact_dir` now uses `runDir()`. Kept `getWorktreePath` reading from the cached `this.worktreeRoot` field so the `Object.create`-based test harness in `launch-eligibility.test.ts` can continue to stub it directly.
- Refactored `src/modules/planning/sub-agent.service.ts`: `artifactDir` now uses `runDir()` instead of inline `join(artifactRoot, "runs", runId)`
- Quality checks: `npx tsc --noEmit` ✅, `npx vitest run` (all 126 tests) ✅, `npx vite build` ✅

## Blockers
- (none currently)
