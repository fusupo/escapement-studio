# Issue #156 — Replace scratchpad .gitignore trick with hard validation guards (ADR 014 step 6)

**Archived:** 2026-04-09
**Branch:** `156-scratchpad-commit-guards`
**Code SHA:** `2db91e3` (develop after merge)
**PR:** [#164](https://github.com/fusupo/escapement-studio/pull/164) — merged
**Status:** Merged

## Summary

Replaced the silent `ensureScratchpadIgnored` gitignore mutation with **hard validation guards** at the two points scratchpads could leak into git history:

1. **Auto-commit** — `autoStageAndCommit` inspects the index after `git add -A` and rejects if any staged path matches `SCRATCHPAD_*.md`.
2. **Pull-request creation** — `createPullRequest` runs both a staged-files check (defense-in-depth for `auto_commit: false` callers) and a committed-history check (`git diff --name-only $base...HEAD`) before any `git push` or `gh pr create`.

On violation the service throws `BadRequestException` and emits a `scratchpad_commit_blocked { phase, paths }` run event so operators see the disobedience signal instead of silent suppression.

## Key Decisions

- **Post-staging guard point** — inspect the index after staging, not before. Catches every staging path (`git add -A`, individual `git add`, helpers) without coupling the guard to *how* files got staged.
- **Staged + committed-history depth at PR time** — auto-commit covers the current turn, but a caller can pass `auto_commit: false` and an earlier turn may already have committed a scratchpad. Both checks run before any remote side effects.
- **Hard fail + event, no auto-recovery** — throwing `BadRequestException` + emitting the event is the whole point. Soft recovery (auto-unstage) would hide the disobedience signal, defeating the purpose of dropping the gitignore trick. Operator triages manually.
- **Three-dot `$base...HEAD` for committed-history** — matches GitHub's PR diff view (merge-base relative) so branches that have merged develop forward don't spuriously flag files introduced on develop itself. Intentional asymmetry with `countCommitsAhead` which uses two-dot.

## Files Changed

- `src/modules/execution/execution.service.ts` (+81 / −22)
  - Removed `ensureScratchpadIgnored` method and its call in `executeRun`
  - Added `findStagedScratchpadViolations`, `findCommittedScratchpadViolations`, `isScratchpadPath` private helpers
  - Added post-staging guard in `autoStageAndCommit`
  - Added staged + committed-history guards in `createPullRequest` before `countCommitsAhead`
- `src/modules/execution/__tests__/scratchpad-commit-guards.test.ts` (+338, new)
  - 16 tests across 5 describe blocks
  - Real `git init` + `mkdtempSync` tmp worktrees (actual git semantics, not mocks)
  - `Object.create(ExecutionService.prototype)` harness pattern matches `scratchpad-canonical.test.ts` / `launch-eligibility.test.ts`
  - `runGhIn` stub throws if called → asserts zero remote side effects on rejection

## Quality Gates

- `npx tsc --noEmit` — clean
- `npx vitest run` — 264/264 across 20 files (16 new)
- `npx vite build --config web/vite.config.ts` — 1.38s clean (pre-existing a11y/CSS warnings only)

## Lessons Learned

- **Visible disobedience > silent suppression.** The whole ADR 014 step 6 premise is that hiding the scratchpad via gitignore makes it impossible to tell when the coding agent is trying to commit it. Hard rejection + event surface the signal the operators actually need.
- **Real git in tests pays off for guard code.** Mocking `git diff --cached --name-only` would have let a broken regex pass alongside working code — the tests needed to exercise actual index/history state to be worth anything.
- **LSP diagnostics lied throughout implementation** (phantom "declared but not read" on `ensureScratchpadIgnored` after removal; "never read" on `findCommittedScratchpadViolations` between Task 2 and Task 5). `npx tsc --noEmit` stayed authoritative.
- **Intentional index-leak on rejection.** Not resetting the staged scratchpad after rejection is a feature, not an oversight — the operator needs to inspect the blocked state to figure out what the agent did.
