# Scratchpad: studio-156 — Studio: replace scratchpad .gitignore trick with hard validation guards (ADR 014 step 6)

## Issue Details

- **Issue:** https://github.com/fusupo/escapement-studio/issues/156
- **Repo:** fusupo/escapement-studio
- **Branch:** `156-scratchpad-commit-guards`
- **Base ref:** develop (local `a2c487e`, origin/develop `cf60807` — 1 archive commit ahead locally)
- **ADR:** `docs/adr/014-plans-runs-state-model.md` (step 6 of 8)
- **Contract:** `docs/contracts/plan-and-run-lifecycle.md`
- **Depends on:** #152 (canonical naming, merged), #155 / PR #163 (step 5, merged)

## Description

Today `ExecutionService.ensureScratchpadIgnored` appends `SCRATCHPAD_*.md` to the worktree's `.gitignore` to silently prevent the coding agent from committing the scratchpad. That behavior hides disobedience — the agent can try to stage the file and gitignore quietly drops it.

With canonical scratchpads now living outside the worktree (step 2) and a single `SCRATCHPAD_<slug>.md` naming convention in place, we can delete the gitignore mutation and replace it with **hard guards** at the two points where scratchpads could leak into git history:

1. **Auto-commit** (`autoStageAndCommit`) — reject if staged files include `SCRATCHPAD_*.md`
2. **Pull-request creation** (`createPullRequest`) — reject if staged files OR committed history on the branch include `SCRATCHPAD_*.md`

Rejection is hard (throws `BadRequestException`) and emits a `scratchpad_commit_blocked` run event so operators see the disobedience signal. The existing agent-prompt rule ("never stage `SCRATCHPAD_*.md`") stays in place.

## Acceptance Criteria

- [x] `ensureScratchpadIgnored` method is removed from `ExecutionService`
- [x] The call site in `executeRun` (line ~679) no longer mutates the worktree's `.gitignore`
- [x] No code path writes `SCRATCHPAD_*.md` to any worktree `.gitignore`
- [x] `autoStageAndCommit` runs a post-staging check: `git diff --cached --name-only`, rejects with `BadRequestException` if any match `SCRATCHPAD_*.md` (glob-style — just the pattern, not recursive sub-paths, see Notes)
- [x] On auto-commit rejection, an event of shape `{ type: "scratchpad_commit_blocked", phase: "auto_commit", paths: string[] }` is appended to the run
- [x] `createPullRequest` performs the staged-files check (defense in depth; auto-commit runs first but a caller could pass `auto_commit: false` and manually stage)
- [x] `createPullRequest` also runs a committed-history check: `git diff --name-only $base...HEAD` (three-dot), rejects with `BadRequestException` if any match `SCRATCHPAD_*.md`
- [x] On PR rejection, event `{ type: "scratchpad_commit_blocked", phase: "pull_request" | "pull_request_history", paths: string[] }` is appended to the run
- [x] Agent prompt rule forbidding scratchpad staging stays in place (no change to `buildSetupPrompt` / `buildDoWorkPrompt` rule text)
- [x] Tests cover: auto-commit rejects staged scratchpad, auto-commit accepts non-scratchpad changes, PR creation rejects staged scratchpad, PR creation rejects scratchpad in committed history, rejection event payload shape
- [x] `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config web/vite.config.ts` all pass

## Decisions Made (Phase 3.5 Q&A)

**Q1 — Auto-commit guard point: Post-staging check.**
  **Rationale:** Inspect the index via `git diff --cached --name-only` after staging (any method). Catches every staging path — `git add -A`, individual `git add`, or `git add .` — without coupling the guard to how files got staged.

**Q2 — PR creation guard depth: Staged + committed history.**
  **Rationale:** Auto-commit covers the current turn, but a caller could pass `auto_commit: false`, and earlier agent turns in the run could have committed a scratchpad before the guard landed. Checking `git diff --name-only $base...HEAD` catches scratchpad files already in the branch's commit history. Defense in depth.

**Q3 — Rejection handling: Hard fail + event.**
  **Rationale:** Throw `BadRequestException` and emit `scratchpad_commit_blocked`. Soft recovery (auto-unstage) would hide the disobedience signal, defeating the point of dropping gitignore. Operators intervene manually — the agent prompt already tells the agent not to do this, so a breach is notable.

## Branch Strategy

- Base: `develop` (origin/develop `cf60807`; local `a2c487e` includes #155 archive commit)
- Feature branch: `156-scratchpad-commit-guards` (created, upstream cleared)

## Implementation Checklist

### Task 1 — Remove the gitignore mutation path
- [ ] Delete `ensureScratchpadIgnored(worktreePath)` method (`execution.service.ts:1498-1515`)
- [ ] Remove the call site in `executeRun` (`execution.service.ts:678-679`) — delete both the comment and the method call
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: step 6 replaces the silent gitignore trick with visible guards

### Task 2 — Add a shared scratchpad detector helper
- [ ] Add private method `findStagedScratchpadViolations(worktreePath): string[]` — runs `git diff --cached --name-only` and filters for `SCRATCHPAD_*.md` at any path depth (matches basename)
- [ ] Add private method `findCommittedScratchpadViolations(worktreePath, baseRef, branch): string[]` — runs `git diff --name-only $baseRef...HEAD` and filters the same way
- [ ] Both helpers return the matching file list (empty when clean) so callers can include violations in error messages and events
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: shared logic keeps the guard definition in one place and makes tests trivial to write

### Task 3 — Guard `autoStageAndCommit`
- [ ] After the `git add -A` call, invoke `findStagedScratchpadViolations(run.worktree_path)`
- [ ] If non-empty: append event `{ type: "scratchpad_commit_blocked", phase: "auto_commit", paths }`, throw `BadRequestException` with message naming the violating files and directing the operator to unstage them
- [ ] Do NOT reset the index — the operator inspects the blocked state and decides what to do
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: primary guard at the most common commit path

### Task 4 — Guard `createPullRequest` — staged files
- [ ] After the `autoStageAndCommit` call (which may or may not run), invoke `findStagedScratchpadViolations` again
- [ ] On violation: append event `{ type: "scratchpad_commit_blocked", phase: "pull_request", paths }`, throw `BadRequestException`
- [ ] This runs even when `auto_commit: false` — covers the manual-stage path
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: auto-commit guard is inside an optional branch; this is the belt to the auto-commit suspenders

### Task 5 — Guard `createPullRequest` — committed history
- [ ] After the staged check, invoke `findCommittedScratchpadViolations(run.worktree_path, baseRef, run.branch)`
- [ ] On violation: append event `{ type: "scratchpad_commit_blocked", phase: "pull_request_history", paths }`, throw `BadRequestException` naming the violating commits' files and pointing the operator at `git log -- SCRATCHPAD_*.md` for context
- [ ] Runs before `git push` and `gh pr create` — no remote side effects on violation
- [ ] Files affected: `src/modules/execution/execution.service.ts`
- [ ] Why: catches scratchpad files committed in earlier turns or by callers that bypassed `autoStageAndCommit` entirely

### Task 6 — Tests
- [ ] New test file: `src/modules/execution/__tests__/scratchpad-commit-guards.test.ts`
- [ ] Use real `git init` in `mkdtempSync` tmp worktrees so `git diff --cached --name-only` and `git diff --name-only` behave authentically — mocking git would be fragile and miss the whole point of the guards
- [ ] Test harness: `Object.create(ExecutionService.prototype)` pattern (matches `launch-eligibility.test.ts`, `scratchpad-canonical.test.ts`)
- [ ] Stub `appendEvent` with `vi.fn()` to assert payload shape
- [ ] **Test cases:**
  - `autoStageAndCommit` — happy path: normal file staged + committed, no throw, no block event
  - `autoStageAndCommit` — rejects `SCRATCHPAD_<slug>.md` at worktree root: throws, emits `scratchpad_commit_blocked { phase: "auto_commit", paths }`, commit is NOT created
  - `autoStageAndCommit` — rejects `SCRATCHPAD_any.md` at nested path (covers basename match)
  - `autoStageAndCommit` — clean worktree (nothing staged): no throw, no event, early-returns as before
  - `findStagedScratchpadViolations` — empty index returns `[]`
  - `findCommittedScratchpadViolations` — no commits ahead returns `[]`
  - `findCommittedScratchpadViolations` — scratchpad committed in an earlier commit is detected
  - `createPullRequest` — staged scratchpad guard: emits `{ phase: "pull_request" }` and throws; no `git push` attempted
  - `createPullRequest` — committed-history guard: emits `{ phase: "pull_request_history" }` and throws; no `git push` attempted
- [ ] For `createPullRequest` tests, stub `runGitIn(..., ["push", ...])` and `runGhIn` to fail the test if called (asserting no side effects on rejection)
- [ ] Files affected: `src/modules/execution/__tests__/scratchpad-commit-guards.test.ts` (new)
- [ ] Why: the guards must be testable in isolation; this is the primary deliverable of the issue

### Task 7 — Delete dead imports and verify
- [ ] Check whether `writeFileSync` / `readFileSync` imports at the top of `execution.service.ts` are still used elsewhere after removing `ensureScratchpadIgnored` — leave them if so, remove if not
- [ ] Run all three quality gates

### Quality Gates
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — all suites green, new tests counted
- [ ] `npx vite build --config web/vite.config.ts` clean

## Technical Notes

### Pattern matching semantics

The issue says "any staged `SCRATCHPAD_*.md`" — match by **basename**, not by path. The canonical scratchpad convention is `SCRATCHPAD_<slug>.md` at the worktree root (or any path, defensively). `git diff --cached --name-only` returns repo-relative paths; the filter should look at the basename:

```ts
const isScratchpad = (p: string) => /(?:^|\/)SCRATCHPAD_[^/]*\.md$/.test(p);
```

### Base-ref symmetry with `countCommitsAhead`

`createPullRequest` already calls `countCommitsAhead(run.worktree_path, baseRef, run.branch)` which almost certainly uses `git rev-list baseRef..branch` or similar. The committed-history guard should use the **same base ref** (`input.base_ref?.trim() || run.base_ref || getDefaultWorkingBranch(workItem.repo)`) so the guard's "commits ahead of base" view matches the PR's "commits ahead of base" view.

Use three-dot `$base...HEAD` (merge-base relative) so branches that have merged develop forward don't spuriously flag files introduced on develop itself.

### Event shape

Existing events are `Record<string, unknown>`. Keep the new event flat and greppable:

```ts
this.appendEvent(run, {
  type: "scratchpad_commit_blocked",
  phase: "auto_commit" | "pull_request" | "pull_request_history",
  paths: string[],
});
```

No new TypeScript types required — `appendEvent` takes `Record<string, unknown>`.

### What happens to an existing `.gitignore` with the entry?

After this change, newly created worktrees won't get the `SCRATCHPAD_*.md` entry. Worktrees that already have it (from pre-#156 runs) are harmless — the entry just becomes inert noise. No cleanup migration is needed because worktrees are ephemeral (step 4 cleanup flow).

### Out of scope

- ADR 014 step 7 (run disposition) — auto-classification of run failures is explicitly deferred
- UI surface for `scratchpad_commit_blocked` events — events are recorded but no frontend rendering is part of this step (operators see them via the existing event stream)
- Cleanup of any legacy `.gitignore` entries in active worktrees — inert and will be removed when the worktree is cleaned
- Any change to `buildSetupPrompt` / `buildDoWorkPrompt` prompt rules — the agent-level rule stays as-is

## Questions/Blockers

### Clarifications Needed
(none — resolved in Phase 3.5)

### Blocked By
(none — step 5 is merged)

### Assumptions Made
- `git diff --cached --name-only` is available in all supported git versions (it is — git 1.6+)
- `runGitIn` returns stdout as a string; a trimmed newline-split produces the file list
- No test currently depends on the `.gitignore` mutation behavior (verified via grep — only `execution.service.ts` references `ensureScratchpadIgnored`)

## Work Log

### 2026-04-09 — Session: implementation

- **Task 1** — Removed `ensureScratchpadIgnored` method and its call in `executeRun`. No migration needed for worktrees that already have the legacy entry (inert noise).
- **Tasks 2 & 3** — Added three helpers on `ExecutionService`:
  - `findStagedScratchpadViolations(worktreePath)` — runs `git diff --cached --name-only`, filters via `isScratchpadPath`.
  - `findCommittedScratchpadViolations(worktreePath, baseRef)` — runs `git diff --name-only $baseRef...HEAD` (three-dot).
  - `isScratchpadPath(path)` — regex `/(?:^|\/)SCRATCHPAD_[^/]*\.md$/` (basename match at any depth).
  Guarded `autoStageAndCommit` right after `git add -A`: on violation it emits `scratchpad_commit_blocked { phase: "auto_commit", paths }` and throws `BadRequestException`. Index is left as-is — operator triage.
- **Tasks 4 & 5** — Guarded `createPullRequest`: staged-files check (phase `pull_request`) runs after `autoStageAndCommit` so the `auto_commit: false` path is covered, then committed-history check (phase `pull_request_history`) runs before `countCommitsAhead` so no `git push` or `gh pr create` side effects fire on rejection.
- **Task 6** — New test file `src/modules/execution/__tests__/scratchpad-commit-guards.test.ts`, 16 tests across 5 describe blocks. Real `git init` + `mkdtempSync` tmp worktrees so the guards exercise actual git semantics. Harness stubs `runGhIn` to throw if called, asserting zero side effects on rejection.
- **Task 7** — All three quality gates clean:
  - `npx tsc --noEmit` — clean
  - `npx vitest run` — 264/264 across 20 files (16 new)
  - `npx vite build --config web/vite.config.ts` — 1.38 s, only pre-existing a11y/CSS warnings

### Notes

- LSP reported several phantom diagnostics throughout (e.g. line 1370-1402 `node`/`workItem`/`projectContext` unused on `buildSetupPrompt`, and `findCommittedScratchpadViolations` "never read" before Task 5 landed). All cleared against `npx tsc --noEmit`, which is authoritative.
- A `deprecated` lint on `toThrowError` in vitest → swapped all occurrences to `toThrow`.
- Intentional: I did NOT reset the index on `auto_commit` rejection. The operator inspects the blocked state and decides whether to unstage, investigate where the scratchpad came from, or abort the run. Auto-recovery would hide the disobedience signal — which is the entire point of replacing the gitignore trick.

### Status

- All implementation tasks complete
- Quality checks: passed
- Ready for commit + PR

---
**Generated:** 2026-04-09
**By:** setup-work skill
**Source:** https://github.com/fusupo/escapement-studio/issues/156
