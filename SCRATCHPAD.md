# Scratchpad: studio-90 — Studio: auto-staged graph proposals can use stale placeholder work item IDs after GitHub assigns final issue numbers

## Context
- **Repo:** fusupo/escapement-studio
- **Issue:** https://github.com/fusupo/escapement-studio/issues/90
- **Branch:** studio-90-branch
- **Base ref:** develop
- **Scope hint:** Fix auto-staged graph proposals so issue-backed IDs are rewritten to the actual GitHub issue number returned by GitHub before proposal staging and child references are generated.
- **Created:** 2026-04-08T20:29:59.289Z

## Summary
- The failing path is `github_create_issue` in `src/modules/planning/planning.service.ts`: it creates the GitHub issue first, but then still trusts the caller-supplied `work_item_id` when staging the `create_work_item` mutation. If the caller guessed `studio-82` and GitHub returned `#83`, the proposal ends up with a misaligned issue-backed ID and fails graph validation.
- That same auto-staging flow also builds `create_edge` mutations from `parent_id` / `depends_on_ids`, so grouped epic + child creation in one turn can accumulate edges that still point at placeholder IDs instead of the final canonical `studio-{issue_number}` ID.
- The fix should canonicalize issue-backed IDs from the actual GitHub issue number before staging the proposal, then rewrite related parent/dependency references so all staged mutations consistently reference the final aligned ID.

## File Ownership

### Owned
- web/src/lib/api.js
- src/modules/git
- README.md

### Shared
- (none)

### Forbidden
- docs/contracts/github-sync.md
- docs/contracts/run-artifacts.md
- src/modules/execution
- src/modules/settings
- web/src/App.svelte
- web/src/components/ExecutionDispatchPanel.svelte
- web/src/components/GraphView.svelte
- web/src/components/SettingsPanel.svelte
- web/src/components/Sidebar.svelte
- web/src/lib/api.js

## Acceptance Criteria
- [x] After GitHub creates an issue, the staged graph proposal uses the actual assigned GitHub issue number to derive the issue-backed work item ID.
- [x] For issue-backed items created through auto-staging, `entity_id` / graph work item ID always aligns with `issue_number`.
- [x] Epic/child and dependency relationships created during grouped issue flows reference the final aligned parent ID, not a pre-creation placeholder ID.
- [x] Multi-issue auto-staged proposals do not accumulate invalid child/dependency references when placeholder IDs differ from the final GitHub issue number.
- [x] Regression coverage exists for epic + child issue creation flows that previously produced misaligned IDs or missing-parent validation failures.

## Implementation Plan
- [x] Update `src/modules/planning/planning.service.ts` so `github_create_issue` always derives the staged issue-backed work item ID from `created.number` (reusing the graph ID convention helper), rewrites the `create_work_item` mutation's `entity_id` and `payload.id`, and never stages the pre-creation placeholder ID after GitHub responds.
- [x] Extend `src/modules/planning/planning.service.ts` with same-turn placeholder-to-final ID resolution for accumulated multi-issue proposals so `parent_id` and `depends_on_ids` are rewritten to the final aligned IDs before `create_edge` mutations are staged.
- [x] Add focused regression tests in `src/modules/planning/__tests__/planning.service.test.ts` for: (1) single issue creation where requested `work_item_id` and returned issue number differ, (2) epic + child creation where the child references the parent's placeholder ID, and (3) dependency references in grouped proposals use the rewritten final ID.
- [x] Verify with `npm run check` and targeted `npx vitest run src/modules/planning/__tests__/planning.service.test.ts` (plus full `npm test` if the worktree environment allows it), then record any environment-related test limitations in this scratchpad.

## Affected Files
- `src/modules/planning/planning.service.ts` — canonicalize issue-backed IDs after GitHub issue creation, track placeholder-to-final aliases during proposal accumulation, and ensure staged edges reference final aligned IDs.
- `src/modules/planning/__tests__/planning.service.test.ts` — add regression coverage for placeholder-ID rewriting and grouped epic/child creation flows.

## Quality Checks
- [x] TypeScript compilation passes (`npm run check`)
- [ ] Tests pass (`npm test`) — targeted `npx vitest run src/modules/planning/__tests__/planning.service.test.ts` passed, but full `npm test` is blocked by missing `better-sqlite3` native bindings in existing graph tests in this worktree.
- [x] Build succeeds (`npm run build:web`)

## Questions / Concerns
- Assumption: for `github_create_issue`, any caller-supplied `work_item_id` is only a pre-creation hint and may be silently canonicalized to `studio-${created.number}` once GitHub returns the real issue number. That matches the issue scope and existing graph validation rules.
- No other blockers found from the current code surface.
- Everything else is clear.

## Work Log

### 2026-04-08 - Setup
- Scratchpad created by Studio execution service
- Branch: studio-90-branch
- Reviewed the `github_create_issue` auto-staging path in `src/modules/planning/planning.service.ts` plus graph ID-alignment validation in `src/modules/graph/types.ts` / `src/modules/graph/graph-writer.service.ts` to scope the fix and test surface.
- Implemented the first fix in `src/modules/planning/planning.service.ts`: auto-staged issue-backed work items now derive their staged ID from `deriveIssueWorkItemId(created.number)` instead of trusting a stale pre-creation `work_item_id` hint.
- Extended `src/modules/planning/planning.service.ts` with turn-scoped placeholder→final ID alias tracking so grouped `github_create_issue` flows rewrite `parent_id`, `depends_on_ids`, and previously accumulated proposal references to the final canonical issue-backed IDs.
- Added `src/modules/planning/__tests__/planning.service.test.ts` with regression coverage for mismatched placeholder IDs, epic/child parent rewrites, dependency rewrites, and the case where a later issue creation retroactively fixes an earlier accumulated child reference.
- Verified the change with `npm run check` ✅, `npx vitest run src/modules/planning/__tests__/planning.service.test.ts` ✅, and `npm run build:web` ✅. Full `npm test` still fails in pre-existing graph tests because this worktree is missing `better-sqlite3` native bindings.
- Completion summary: `github_create_issue` now stages issue-backed work items with canonical IDs derived from the actual GitHub issue number, grouped proposal edges resolve placeholder parent/dependency IDs to the final canonical IDs, and regression coverage now protects the previously failing multi-issue proposal paths.

## Blockers
- Full `npm test` is blocked by missing `better-sqlite3` native bindings in this worktree (`Could not locate the bindings file` from existing `src/modules/graph/__tests__/graph-writer.service.test.ts`).
