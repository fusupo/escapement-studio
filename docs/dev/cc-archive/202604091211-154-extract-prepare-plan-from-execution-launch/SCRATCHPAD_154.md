# Scratchpad: studio-154 — Studio: extract prepare-plan from execution launch (ADR 014 step 4)

## Issue Details

- **Issue:** https://github.com/fusupo/escapement-studio/issues/154
- **Repo:** fusupo/escapement-studio
- **Branch:** `154-extract-prepare-plan-from-execution-launch`
- **Base ref:** develop
- **ADR:** docs/adr/014-plans-runs-state-model.md (step 4 of 8)
- **Contract:** docs/contracts/plan-and-run-lifecycle.md

## Description

Introduce a standalone plan preparation operation that drafts or updates the canonical scratchpad for a work item WITHOUT creating a worktree, and transitions the work item through `planned → drafting → ready` with an explicit human approval gate.

This extracts the scratchpad-drafting concern that currently lives inside `ExecutionService.executeRun` (setup phase + worktree creation) so it can stand alone as a pre-execution step. The net result is that by the time `launch` is called the scratchpad already exists at `plans/<slug>/SCRATCHPAD_<slug>.md` and the work item is in state `ready`.

## Acceptance Criteria

- [ ] `POST /api/plans/:work_item_id/prepare` exists and is callable
- [ ] Prepare transitions work item `planned → drafting` (or is idempotent if already `drafting`)
- [ ] Prepare drafts `plans/<slug>/SCRATCHPAD_<slug>.md` using issue body, graph context, and canonical Studio issue templates (via `StudioIssueTemplateService`)
- [ ] Prepare writes/updates `plans/<slug>/metadata.json` with full plan state, timestamps, and `approved_by`/`approved_at` fields (null until approval)
- [ ] `POST /api/plans/:work_item_id/approve` transitions `drafting → ready` and writes `approved_at` + `approved_by` to metadata.json
- [ ] `POST /api/plans/:work_item_id/reopen` transitions `ready → drafting` and clears `approved_at`/`approved_by` in metadata.json
- [ ] `GET /api/plans/:work_item_id` returns plan metadata + scratchpad content
- [ ] At approval, `predicted_files` is auto-refined from the plan's `## Affected Files` section; the diff (added/removed paths) is returned in the approve response so the reviewer sees it
- [ ] Prepare does NOT create a worktree
- [ ] Tests cover: prepare (happy path, idempotent re-draft), approve, reopen, predicted_files diff refinement
- [ ] `tsc --noEmit`, `vitest run`, and `vite build` all pass

## Branch Strategy

- Base: `develop`
- Feature branch: `154-extract-prepare-plan-from-execution-launch`

---

## Implementation Checklist

### Task 1 — Expand plan metadata schema in context-layout.ts

**Files:** `src/lib/context-layout.ts`, `src/lib/__tests__/context-layout.test.ts`

**Why:** The existing `PlanMetadataMarker` interface (internal to `ensurePlanDir`) only holds `plan_id`, `work_item_id`, and `created_at`. The contract requires a richer `PlanMetadata` shape with `state`, `updated_at`, `approved_at`, `approved_by`, `scratchpad_path`, and `run_ids`. This foundation is needed by every subsequent task.

**Changes:**
- Export a new `PlanMetadata` interface (the full shape from the contract spec)
- Export a new `planMetadataPath(artifactRoot, workItemId)` path helper
- Update `ensurePlanDir` to write the full `PlanMetadata` shape on first creation (with `state: "drafting"`, `run_ids: []`, null approver fields)
- Update the existing `PlanMetadataMarker` read path to tolerate both old (3-field) and new shapes (backward-compat for any existing plan dirs)
- Export a `readPlanMetadata` helper and a `writePlanMetadata` helper (keeps FS I/O centralized, makes mocking in tests trivial)

**Verification:** `npm run check` (tsc), update `context-layout.test.ts` with new shape assertions

---

### Task 2 — Create PlansService

**Files:** `src/modules/plans/plans.service.ts` (new), `src/modules/plans/types.ts` (new)

**Why:** There is no `plans` module yet. This service owns all plan lifecycle operations: prepare, approve, reopen, and predicted_files refinement. It is a pure NestJS `@Injectable()` with no circular dependencies — it depends on `WorkItemsService` (from GraphModule) and `GitHubService` (from GitHubModule), both of which are already available without forwardRef.

**Changes in `types.ts`:**
- `PreparePlanDto` — `{ work_item_id: string }`
- `ApprovePlanDto` — `{ approved_by?: string }` (defaults to `"local"`)
- `ReopenPlanDto` — empty or `{ reason?: string }`
- `PlanResponse` — `{ plan_id, work_item_id, state, scratchpad_content, metadata, predicted_files_diff? }`
- `PredictedFilesDiff` — `{ added: string[]; removed: string[]; unchanged: string[] }`

**Changes in `plans.service.ts`:**
- `prepare(workItemId: string): Promise<PlanResponse>` — transitions `planned → drafting`, calls `ensurePlanDir`, builds scratchpad (see Task 3), writes metadata
- `approve(workItemId: string, dto: ApprovePlanDto): Promise<PlanResponse>` — validates current state is `drafting`, transitions `drafting → ready`, extracts Affected Files from scratchpad, computes diff against `predicted_files`, updates `predicted_files` on the work item, records `approved_at`/`approved_by` in metadata, returns the diff
- `reopen(workItemId: string): Promise<PlanResponse>` — validates current state is `ready`, transitions `ready → drafting`, clears `approved_at`/`approved_by` in metadata
- `get(workItemId: string): PlanResponse` — reads metadata.json and scratchpad, assembles response

**Verification:** `npm run check`

---

### Task 3 — Extract `fetchIssueBody` helper to `src/lib/github-cli.ts`

**Files:** `src/lib/github-cli.ts` (new), `src/modules/execution/execution.service.ts` (replace private method with import)

**Why:** Both `ExecutionService` and the new `PlansService` need to fetch issue bodies via `gh issue view`. Per Q1 decision, extract the existing 12-line private `ExecutionService.fetchIssueBody` (lines ~604–615) into a standalone helper module so both services can import it. Side benefit: future code that needs `gh` CLI wrappers gets a central home.

**Changes in `src/lib/github-cli.ts`:**
- Export `fetchIssueBody(repo: string, issueNumber: number): string | null`
- Use `execFileSync("gh", ["issue", "view", ...], { encoding: "utf8" })`
- Return `null` on failure (caller decides how to surface it) — match current ExecutionService semantics

**Changes in `execution.service.ts`:**
- Delete the private `fetchIssueBody` method
- Import `fetchIssueBody` from `../../lib/github-cli.js` and update call sites (probably just one or two)

**Verification:** `npm run check` + `vitest run` (existing execution tests must still pass — fetchIssueBody is mocked in most test harnesses, but grep for any that instantiate the real method)

---

### Task 4 — Implement scratchpad builder for prepare (no worktree)

**Files:** `src/modules/plans/plans.service.ts` (continued), `src/modules/github/studio-issue-template.service.ts` (read-only reference)

**Why:** The existing `buildScratchpad` in `ExecutionService` takes an `ExecutionRunRecord` and a `ExecutionDispatchNodePreview` — both of which require an active run and dispatch graph evaluation. Prepare has neither. A new builder takes `WorkItemRecord` + optional `issueBody` + `StudioIssueTemplate[]` and produces the same markdown skeleton, adapted to omit run-specific fields (run_id, artifact_dir) while adding the issue template sections (Summary, Background, Problem, Proposed Behavior from the feature template).

**Changes:**
- Add `private buildPlanScratchpad(workItem: WorkItemRecord, issueBody: string | null, templates: StudioIssueTemplate[]): string` to `PlansService`
- The scratchpad structure matches existing `buildScratchpad` output but:
  - Replaces `## Context` run fields (run_id, branch, base_ref) with plan fields (plan_id, created_at)
  - Keeps `## File Ownership` using `workItem.predicted_files` as the starting `## Owned` list
  - Adds `## Summary`, `## Acceptance Criteria`, `## Implementation Plan`, `## Affected Files`, `## Quality Checks`, `## Questions / Concerns`, `## Work Log`, `## Blockers` sections — seeded from the issue template structure
  - Adds issue body inline (same pattern as `buildSetupPrompt` in ExecutionService)
  - **Skeleton only** — per Q2 decision, no sub-agent involvement. The structured template is seeded from the issue body + Studio issue template; the human or the Planner skill fills in the implementation plan externally before approval.
- Re-uses `StudioIssueTemplateService.listTemplates()` directly (not `getPlanningDocument()` which is chat-intent-gated)
- Fetches issue body via `fetchIssueBody` from `src/lib/github-cli.ts` (extracted in Task 3)

**Verification:** `npm run check`, unit test in Task 7

---

### Task 5 — Implement predicted_files auto-refinement

**Files:** `src/modules/plans/plans.service.ts` (continued), new private `extractAffectedFiles` method

**Why:** At approval time, `predicted_files` should be refreshed from whatever the `## Affected Files` section of the scratchpad contains. This is a pure text-parsing operation — scan the scratchpad for the `## Affected Files` heading, extract bare filenames from list items (`- path/to/file.ts`), diff them against the current `workItem.predicted_files`, update the work item, and return the diff.

**Changes:**
- `private extractAffectedFiles(scratchpadContent: string): string[]` — parses `## Affected Files` section, returns normalized paths
- In `approve()`: after state transition, call `extractAffectedFiles`, compute diff (`added = newFiles \ old`, `removed = old \ newFiles`), call `workItemsService.update(id, { predicted_files: newFiles })`, include diff in response
- If `## Affected Files` section is empty or absent, `predicted_files` is left unchanged and diff is `{ added: [], removed: [], unchanged: [...current] }`

**Verification:** `npm run check`, unit test in Task 9

---

### Task 6 — Create PlansController and PlansModule

**Files:** `src/modules/plans/plans.controller.ts` (new), `src/modules/plans/plans.module.ts` (new)

**Why:** The four REST endpoints need a NestJS controller wired to `PlansService`. The module is deliberately thin — it imports `GraphModule` (for `WorkItemsService`) and `GitHubModule` (for `StudioIssueTemplateService`), exports nothing (it is a leaf module).

**Changes in `plans.controller.ts`:**
```
@Controller("api/plans")
POST /:work_item_id/prepare  → plansService.prepare(id)
POST /:work_item_id/approve  → plansService.approve(id, body)
POST /:work_item_id/reopen   → plansService.reopen(id)
GET  /:work_item_id          → plansService.get(id)
```

**Changes in `plans.module.ts`:**
- `imports: [GraphModule, GitHubModule]`
- `providers: [PlansService]`
- No `exports` needed

**Register in `src/app.module.ts`:** add `PlansModule` to the `imports` array. Confirm that `AppModule` already imports `GraphModule` via its own import chain — no new circular dependency is introduced since `PlansModule` does not import `ExecutionModule`.

**Verification:** `npm run check`, manual `curl` smoke test

---

### Task 7 — Register PlansModule in AppModule

**Files:** `src/app.module.ts`

**Why:** Without this the controller never gets mounted. Kept as a separate task because it is the integration point most likely to surface dependency ordering issues.

**Changes:**
- Import `PlansModule` and add it to `AppModule.imports`
- Verify no new forwardRef is needed (PlansModule → GraphModule is one-directional)

**Verification:** `npm run check`, server starts without error (`npm run dev`)

---

### Task 8 — Unit tests for PlansService.prepare and scratchpad builder

**Files:** `src/modules/plans/__tests__/plans.service.test.ts` (new)

**Why:** The scratchpad builder and prepare flow are pure functions that can be tested with the same `Object.create` harness pattern used in the existing execution tests. No real filesystem or NestJS DI needed. Mock `fetchIssueBody` from `src/lib/github-cli.js` via `vi.mock` so prepare runs synchronously without shelling out to `gh`.

**Test cases:**
- `prepare` transitions `planned → drafting` on a fresh work item
- `prepare` is idempotent when work item is already `drafting` (re-drafts scratchpad, does not throw)
- `prepare` throws `BadRequestException` when work item is in a non-preparable state (e.g. `in_progress`, `done`)
- `buildPlanScratchpad` includes `## Affected Files` section
- `buildPlanScratchpad` includes issue body when present
- `buildPlanScratchpad` includes `## Acceptance Criteria` from issue template scaffold

**Pattern:** Mirror `build-scratchpad.test.ts` — use `Object.create(PlansService.prototype)` and inject stub `workItemsService` and `artifactRoot`.

**Verification:** `vitest run --reporter=verbose`

---

### Task 9 — Unit tests for approve, reopen, and predicted_files diff

**Files:** `src/modules/plans/__tests__/plans.service.test.ts` (continued)

**Why:** The approval flow has the most important correctness invariants — wrong state transitions, diff accuracy, metadata write correctness. Separate from Task 7 to keep test file scannable.

**Test cases:**
- `approve` transitions `drafting → ready`, writes `approved_at`/`approved_by` to metadata
- `approve` returns correct `predicted_files_diff` when `## Affected Files` has new paths
- `approve` returns diff with only `unchanged` entries when `## Affected Files` matches existing `predicted_files`
- `approve` returns empty diff with `unchanged = current` when `## Affected Files` section is absent
- `approve` throws `BadRequestException` when work item is not in `drafting` state
- `reopen` transitions `ready → drafting`, clears `approved_at` in metadata
- `reopen` throws when work item is not in `ready` state

**Pattern:** Use a real tmp dir (via `mkdtempSync`) for the metadata.json assertions, same pattern as `scratchpad-canonical.test.ts`.

**Verification:** `vitest run --reporter=verbose`

---

### Task 10 — Integration test: full prepare → approve cycle with state validation

**Files:** `src/modules/plans/__tests__/plans-lifecycle.test.ts` (new)

**Why:** The individual unit tests cover each method in isolation. This test covers the full state machine arc end-to-end: `planned → drafting → ready → drafting` (via reopen), using real temp dirs and stubbed work item service. It also validates that metadata.json is correctly updated at each stage.

**Test cases:**
- Full arc: prepare → approve → reopen → approve again
- Verify work item state at each stage
- Verify metadata.json `state` field matches work item state at each stage
- Verify `approved_at` is set after approve, cleared after reopen

**Verification:** `vitest run --reporter=verbose`

---

### Task 11 — Wire predicted_files update into WorkItemsService and confirm existing tests pass

**Files:** `src/modules/plans/plans.service.ts`, existing test files (read-only verify)

**Why:** Task 5 calls `workItemsService.update(id, { predicted_files: newFiles })`. This is already supported by `WorkItemsService.update` → `GraphWriterService.apply`. However the `UpdateWorkItemDto` in `src/modules/graph/types.ts` should be checked to confirm `predicted_files` is an optional field there. If it is absent, a one-line addition is needed.

**Changes (if needed):**
- Add `predicted_files?: string[]` to `UpdateWorkItemDto` in `src/modules/graph/types.ts`
- Confirm `GraphWriterService` and the SQLite layer accept it (it almost certainly does given the existing `actual_files` update flow)

**Verification:** `npm run check`, `vitest run` (no regressions)

---

### Task 12 — Final pass: tsc + vitest + vite build

**Files:** no new files

**Why:** Confirm all three quality gates pass with the full set of changes in place, per the acceptance criteria.

**Verification:**
- `npm run check` (tsc --noEmit)
- `vitest run`
- `npm run build:web`

---

## Technical Notes

### Architecture

**No new circular dependency.** The existing `GraphModule ↔ ExecutionModule` forwardRef cycle is the only cycle in the app. `PlansModule` imports `GraphModule` and `GitHubModule` but nothing in those modules imports `PlansModule`. This is a clean one-directional dependency.

**PlansService dependency graph:**
```
PlansService
  ← WorkItemsService (from GraphModule)
  ← StudioIssueTemplateService (from GitHubModule)
  ← context-layout helpers (lib, no DI)
  ← node:fs, node:child_process (for issue body fetch + metadata I/O)
```

**Scratchpad builder split.** `ExecutionService.buildScratchpad` takes an `ExecutionRunRecord + ExecutionDispatchNodePreview` — this is the right shape for an active execution. `PlansService.buildPlanScratchpad` takes a `WorkItemRecord + issueBody + templates`. These are different shapes for different lifecycle phases. Do NOT attempt to unify them in this step. ADR 014 step 5 is the right place to decide whether the execution builder should seed from the canonical plan scratchpad or remain independent.

**metadata.json evolution.** The existing `PlanMetadataMarker` (written by `ensurePlanDir`) has only 3 fields. After Task 1 the full schema is written on creation. The `readPlanMetadata` helper should handle the old 3-field shape gracefully by treating missing fields as their zero/null values — this protects any existing plan dirs created by prior step tests.

**Approver identity.** V1 is single-user local — `approved_by` defaults to `"local"` unless the caller passes a value in `ApprovePlanDto`. There is no authentication system in Studio today. Do not invent one here.

**predicted_files extraction.** Parse the `## Affected Files` section by scanning for the heading and collecting `- ` list items until the next `##` heading or EOF. Strip inline notes (e.g. `- src/foo.ts — add new helper` → `src/foo.ts`) by taking everything before the first ` —` or ` (`. Do not attempt to parse code fences or nested lists.

**prepare idempotency.** If the work item is already in `drafting` state, `prepare` should re-draft the scratchpad (overwrite it) and update `metadata.json.updated_at`. If the canonical scratchpad already exists and is non-empty, the service should preserve the existing content rather than overwriting it (to not destroy work-in-progress plan edits). This matches the behavior of `writeScratchpad` in `ExecutionService` which carries forward existing canonical content on repeat calls. If the scratchpad is empty/absent, generate a fresh skeleton.

**State validation in prepare.** Valid pre-states for prepare: `planned`, `drafting`. Invalid: everything else. Throw `BadRequestException` with a message explaining which states are preparable.

### Implementation approach

**What gets extracted:** The issue-body fetch (`fetchIssueBody`), the project-conventions read (`readProjectContext`), and the skeleton scratchpad generation (`buildScratchpad`) are currently private methods in `ExecutionService`. Per Q1 decision, `fetchIssueBody` is promoted to a standalone helper in `src/lib/github-cli.ts` (Task 3) and both `ExecutionService` and `PlansService` import it from there. `readProjectContext` is NOT needed in prepare because there is no worktree yet (the project root itself is the context). `buildScratchpad` stays put — `PlansService` gets its own `buildPlanScratchpad` (Task 4) because the run-context-aware shape does not match plan-time needs.

**What stays in ExecutionService:** `writeScratchpad` (worktree seeding on launch), `syncScratchpadToCanonical` (phase-boundary sync), `buildScratchpad` (run-context-aware skeleton). These are not touched in this step.

**Launch state guard (ADR 014 step 5 preview).** The issue says prepare-plan is extracted; it does not yet require that launch *requires* a `ready` plan. The existing `launch` code in `ExecutionService` already allows `planned` and `ready` states (per the step 3 test: `marks planned work items in progress before launching execution`). Do not change the launch guard in this step — that is step 5.

### Potential challenges

1. **`StudioIssueTemplateService` injection into PlansService.** `StudioIssueTemplateService` is currently only used by `PlanningService` inside `PlanningModule`. It is exported from `GitHubModule` (check `github.module.ts` to confirm — the glob shows it is a provider there). If it is not exported, it must be added to `GitHubModule.exports` before `PlansModule` can inject it.

2. **`UpdateWorkItemDto.predicted_files` field.** The `update` path in `WorkItemsService` passes `patch` through `GraphWriterService.apply`. Confirm the DTO type and the graph writer mutation schema both accept `predicted_files` as an optional update field. If `GraphWriterService` silently drops unknown patch fields, the predicted_files update will silently no-op.

3. **metadata.json read/write racing with long-running prepare.** Prepare invokes the `gh` CLI to fetch the issue body — this is synchronous (`execFileSync`). The metadata state transition (`planned → drafting`) should happen before the CLI call so that concurrent prepare requests for the same work item fail fast rather than producing two scratchpads.

4. **Test harness for PlansService.** The `Object.create` pattern requires that PlansService constructor dependencies be injectable as plain properties. Confirm that the NestJS `@Inject()` decorator does not interfere with `Object.create`-based test harnesses (the existing tests in the codebase successfully use this pattern for `ExecutionService`, so it should work).

---

## Questions / Blockers

### Decisions Made

Resolved 2026-04-09 during Phase 3.5 Q&A:

**Q1: Where does the `fetchIssueBody` helper live?**
**A:** Extract to `src/lib/github-cli.ts` (Task 3). Both `ExecutionService` and `PlansService` import from there. Slightly wider scope than duplication but cleaner long-term and avoids a second home for the same `gh` CLI pattern.

**Q2: Should `prepare` use a sub-agent to fill the scratchpad or just write a skeleton?**
**A:** Skeleton only. Prepare writes a structured template (Summary, Acceptance Criteria, Implementation Plan, Affected Files) seeded from the issue body + Studio issue template. No agent involvement during prepare. Human or the Planner skill handles deep analysis externally before approval. This keeps the endpoint synchronous and fast, and avoids entangling PlansModule with sub-agent execution machinery.

**Q3: Does `GET /api/plans/:work_item_id` return scratchpad content inline or by reference?**
**A:** Inline. Response shape is `{ metadata: {...}, scratchpad_content: "..." }`, matching the existing `getRunScratchpad` pattern in `ExecutionController`. Simple, consistent with runs, and YAGNI-appropriate for MVP.

### Clarifications Needed

_(none — all resolved above)_

### Blocked By

_(none — dependencies #151, #152, #153 are all merged)_

### Assumptions Made

- `StudioIssueTemplateService` is exported from `GitHubModule` (will verify during Task 6 — if not, add to `GitHubModule.exports` as a trivial side-change)
- `predicted_files` is already an accepted field in the SQLite layer via the existing `actual_files` update path in `GraphWriterService` (will verify during Task 11)
- No authentication system exists in Studio — `approved_by` defaults to `"local"`
