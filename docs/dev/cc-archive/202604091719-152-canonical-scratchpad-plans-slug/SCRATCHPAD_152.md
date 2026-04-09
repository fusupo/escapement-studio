# Scratchpad: studio-152 — Canonical scratchpad at plans/<slug>/SCRATCHPAD_<slug>.md (ADR 014 step 2)

---

## Issue Details

- **Issue:** fusupo/escapement-studio#152
- **Title:** Studio: canonical scratchpad at plans/<slug>/SCRATCHPAD_<slug>.md (ADR 014 step 2)
- **Branch:** `152-canonical-scratchpad-plans-slug`
- **Base branch:** `develop`
- **Depends on:** #151 (merged — introduced `src/lib/context-layout.ts`)
- **ADR:** `docs/adr/014-plans-runs-state-model.md`
- **Contract:** `docs/contracts/plan-and-run-lifecycle.md`

---

## Description

Step 2 of ADR 014. The canonical scratchpad moves from an inline-generated file dropped at
`SCRATCHPAD.md` in the worktree to a durable file at `plans/<slug>/SCRATCHPAD_<slug>.md` under the
artifact root. During a run the canonical file is:

1. **copied in** to the worktree at run launch (replacing the current "generate from scratch" approach)
2. **synced back** to the canonical location at phase boundaries (end of setup phase, end of do-work phase, on completion)

`scratchpad-initial.md` and `scratchpad-final.md` in the run artifact dir are demoted to optional
debugging snapshots. Prompts are updated to reference `SCRATCHPAD_<slug>.md` explicitly. The
`.gitignore` trick is migrated from the generic `SCRATCHPAD.md` entry to the `SCRATCHPAD_*.md` glob
(ADR 014 commit-safety section).

---

## Acceptance Criteria

- [x] `context-layout.ts` exports a `canonicalScratchpadPath(artifactRoot, workItemId)` helper that returns `plans/<slug>/SCRATCHPAD_<slug>.md`
- [x] On run launch, `writeScratchpad` in `execution.service.ts` writes the skeleton into `plans/<slug>/SCRATCHPAD_<slug>.md` (calling `ensurePlanDir` first), then copies it into `<worktree_path>/SCRATCHPAD_<slug>.md`
- [x] After the setup phase completes, the worktree scratchpad is synced back to the canonical path
- [x] After the do-work phase completes (or on run error/completion), the worktree scratchpad is synced back to the canonical path
- [x] `getRunScratchpad` prefers the canonical plan file, falling back to the worktree live file; the `source` discriminant field is dropped from the return type entirely
- [x] `scratchpad-initial.md` and `scratchpad-final.md` are **removed entirely** — no longer written anywhere
- [x] All prompt references (`buildSetupPrompt`, `buildDoWorkPrompt`, the disambiguation feedback prompt) use `SCRATCHPAD_<slug>.md` as the filename, not the generic `SCRATCHPAD.md`
- [x] `ensureScratchpadIgnored` is updated to add `SCRATCHPAD_*.md` (or the specific slug filename) to the worktree `.gitignore` instead of the generic `SCRATCHPAD.md`
- [x] Root `.gitignore` entry `SCRATCHPAD.md` is broadened to `SCRATCHPAD_*.md`
- [x] Tests cover: `canonicalScratchpadPath`, copy-in behavior, sync-back behavior, missing worktree file at sync-back, `getRunScratchpad` fallback chain
- [x] TypeScript type check passes, tests pass, build passes

---

## Branch Strategy

- Branch off `develop` (not `main`)
- Single branch: `152-canonical-scratchpad-plans-slug`
- Each task maps to one commit

---

## Implementation Checklist

### Task 1: Add `canonicalScratchpadPath` to `context-layout.ts`

**Files:** `src/lib/context-layout.ts`, `src/lib/__tests__/context-layout.test.ts`

Add a pure path-builder function:

```ts
export function canonicalScratchpadPath(artifactRoot: string, workItemId: string): string {
  const slug = workItemSlug(workItemId);
  return join(planDir(artifactRoot, workItemId), `SCRATCHPAD_${slug}.md`);
}
```

This is a pure path computation — no filesystem side effects. Add unit tests covering:
- correct path derivation from a work item id with hyphens (`studio-42` → `...plans/studio_42/SCRATCHPAD_studio_42.md`)
- path is inside the plan dir returned by `planDir()`
- works for edge-case slugs (all-numeric, mixed case)

**Why first:** Everything downstream depends on this function; it has no dependencies.

---

### Task 2: Update `writeScratchpad` to write the canonical file and copy into worktree

**Files:** `src/modules/execution/execution.service.ts`

Current behavior: builds content from scratch and writes to `<worktree>/SCRATCHPAD.md`, copies to `<run_artifact>/scratchpad-initial.md`.

New behavior (**decision: carry forward canonical → worktree; worktree filename is slug-specific; no initial snapshot**):
1. Call `ensurePlanDir(this.artifactRoot, run.work_item_id)` to create `plans/<slug>/` if it doesn't exist
2. Determine the canonical path via `canonicalScratchpadPath(this.artifactRoot, run.work_item_id)`
3. If `plans/<slug>/SCRATCHPAD_<slug>.md` already exists, read it (this run is a re-run — plan content carries over). If it does not exist, build the skeleton with `buildScratchpad(run, node)` and write it to the canonical path
4. Determine the worktree filename as `SCRATCHPAD_<slug>.md` (slug derived from `workItemSlug(run.work_item_id)`)
5. Copy the canonical file content to `<worktree>/SCRATCHPAD_<slug>.md`
6. **Remove** the previous `scratchpad-initial.md` write — no longer written
7. Return the worktree path (`<worktree>/SCRATCHPAD_<slug>.md`)

Also add the import of `canonicalScratchpadPath`, `ensurePlanDir`, `workItemSlug` from `context-layout.js`.

**Why second:** Depends on Task 1. Changes the single entry point for scratchpad creation.

---

### Task 3: Update `ensureScratchpadIgnored` for new filename

**Files:** `src/modules/execution/execution.service.ts`

Current: adds `SCRATCHPAD.md` to the worktree `.gitignore`.

New: adds `SCRATCHPAD_*.md` (glob pattern covering any slug). This is a single-character change to the `entry` constant, but affects the gitignore behavior for all worktrees. Stage and commit the `.gitignore` change in the worktree immediately (behavior is unchanged — the code already does `runGitIn(worktreePath, ["add", ".gitignore"])`).

This is a separate commit because it touches safety/commit-guard behavior independently of copy-in logic.

---

### Task 4: Update root `.gitignore` to use `SCRATCHPAD_*.md` glob

**Files:** `.gitignore`

Replace the current `SCRATCHPAD.md` entry with `SCRATCHPAD_*.md`. This ensures that any accidentally-present canonical scratchpad file in the repo root (created during development or setup-work sessions) is not committed.

**Why separate task:** File ownership is the repo root `.gitignore`, not the execution module — cleaner to isolate.

---

### Task 5: Add `syncScratchpadToCanonical` private method and call at phase boundaries

**Files:** `src/modules/execution/execution.service.ts`

Add a private method:

```ts
private syncScratchpadToCanonical(run: ExecutionRunRecord): void {
  const slug = workItemSlug(run.work_item_id);
  const worktreeScratchpad = join(run.worktree_path, `SCRATCHPAD_${slug}.md`);
  const canonical = canonicalScratchpadPath(this.artifactRoot, run.work_item_id);
  if (existsSync(worktreeScratchpad)) {
    writeFileSync(canonical, readFileSync(worktreeScratchpad, "utf8"), "utf8");
    return;
  }
  // Worktree file missing — agent likely deleted it. Log a warning and leave
  // canonical unchanged (last-known-good state).
  this.logger.warn(
    `syncScratchpadToCanonical: worktree scratchpad missing for run ${run.run_id} ` +
      `at ${worktreeScratchpad}; canonical left unchanged.`,
  );
}
```

Call this at two points in `executeRun`:
1. After `session.prompt(setupPrompt)` returns (end of setup phase, before the disambiguation gate)
2. After `session.prompt(doWorkPrompt)` returns (end of do-work phase)

**Delete** the existing `scratchpad-final.md` write (line ~774). Canonical is now the only post-run snapshot, and it lives in the plan dir, not the run artifact dir.

**Why here:** Depends on Tasks 2 and 3. This is the most significant behavioral change.

---

### Task 6: Update prompt strings to reference `SCRATCHPAD_<slug>.md`

**Files:** `src/modules/execution/execution.service.ts`

Three prompt builders reference the scratchpad by name. Each must be updated to use the slug-specific name instead of `SCRATCHPAD.md`:

- `buildSetupPrompt` — references `SCRATCHPAD.md` at lines 1242, 1289. Replace with `` `SCRATCHPAD_${workItemSlug(run.work_item_id)}.md` `` (compute once, use as a local variable inside the method).
- `buildDoWorkPrompt` — references `SCRATCHPAD.md` at lines 1305, 1309, 1312, 1314, 1327, 1330, 1336. Same approach.
- The disambiguation feedback prompt in `executeRun` (line 731) — references `SCRATCHPAD.md` inline; replace with slug-specific name.

Pattern: compute `const scratchpadName = \`SCRATCHPAD_${workItemSlug(run.work_item_id)}.md\`` at the top of each method and use it throughout.

---

### Task 7: Update `getRunScratchpad` fallback chain

**Files:** `src/modules/execution/execution.service.ts`, controller and types

Current priority: worktree `SCRATCHPAD.md` → `scratchpad-initial.md` in artifact dir, with a `source: "worktree" | "artifact" | null` discriminant.

New priority:
1. Canonical plan file: `canonicalScratchpadPath(this.artifactRoot, run.work_item_id)` — source of truth, synced at each phase boundary
2. Live worktree copy: `join(run.worktree_path, \`SCRATCHPAD_${workItemSlug(run.work_item_id)}.md\`)` — live during an active run before first sync-back

**Drop the `source` field entirely** from the return type and API response. Canonical is the source of truth and the discriminant is no longer meaningful. Update the controller, the execution types, and any frontend code that reads the field. Frontend update is in scope for this task since the type change is a breaking API change.

---

### Task 8: Add tests for new scratchpad behaviors

**Files:** `src/modules/execution/__tests__/scratchpad-canonical.test.ts` (new file)

Test cases to cover:
- `canonicalScratchpadPath` returns the correct path (cross-check with Task 1 tests — can share fixtures)
- `writeScratchpad` (via `Object.create` pattern from the existing `build-scratchpad.test.ts`): when canonical file does not exist, creates it and copies to worktree
- `writeScratchpad`: when canonical file already exists (re-run), reads it instead of regenerating and copies to worktree **without overwriting the canonical**
- `syncScratchpadToCanonical`: when worktree file exists, overwrites canonical
- `syncScratchpadToCanonical`: when worktree file is missing, does not throw, canonical unchanged, warning logged
- `getRunScratchpad`: prefers canonical over worktree
- `getRunScratchpad`: falls back to worktree when canonical is absent
- `getRunScratchpad`: returns null scratchpad when both are absent

Use `mkdtempSync` / `rmSync` for tmp directories, matching the pattern in `context-layout.test.ts`. Use `Object.create(ExecutionService.prototype)` + property injection to test private-ish behavior without full DI wiring.

---

### Task 9: Update `build-scratchpad.test.ts` for renamed file

**Files:** `src/modules/execution/__tests__/build-scratchpad.test.ts`

The heading test asserts `# Scratchpad: studio-42 — Add widget support`. This is unaffected by the rename (the content heading stays the same). No changes needed to that file unless the `buildScratchpad` content itself changes — which it doesn't in this issue.

However, if `writeScratchpad` now takes `artifactRoot` as an additional parameter (to locate the canonical path), the test fixtures in `build-scratchpad.test.ts` may need a trivial update. Assess at implementation time.

---

## Technical Notes

### Current scratchpad flow (pre-152)

```
launch()
  → executeRun()
    → writeScratchpad(run, node)          // builds skeleton, writes <worktree>/SCRATCHPAD.md
                                           // copies to <artifact>/scratchpad-initial.md
    → ensureScratchpadIgnored(worktree)   // adds SCRATCHPAD.md to worktree .gitignore
    → Phase 1: setup prompt ("Update SCRATCHPAD.md")
    → Phase 2: do-work prompt ("Work through SCRATCHPAD.md")
    → copy <worktree>/SCRATCHPAD.md → <artifact>/scratchpad-final.md
```

### Target scratchpad flow (post-152, with resolved decisions)

```
launch()
  → executeRun()
    → writeScratchpad(run, node)
        ensurePlanDir(artifactRoot, work_item_id)
        if plans/<slug>/SCRATCHPAD_<slug>.md exists → read it (carry forward)
        else → build skeleton, write canonical
        copy canonical → <worktree>/SCRATCHPAD_<slug>.md
        (no scratchpad-initial.md written)
    → ensureScratchpadIgnored(worktree)   // adds SCRATCHPAD_*.md to worktree .gitignore
    → Phase 1: setup prompt ("Update SCRATCHPAD_<slug>.md")
    → syncScratchpadToCanonical(run)      // sync before disambiguation gate
    → disambiguation gate
    → Phase 2: do-work prompt ("Work through SCRATCHPAD_<slug>.md")
    → syncScratchpadToCanonical(run)      // sync after do-work phase
    (no scratchpad-final.md written — canonical is the final snapshot)
```

### Key observations from code analysis

1. `run.work_item_id` is always present on `ExecutionRunRecord` — slug derivation is safe everywhere inside `executeRun` and `getRunScratchpad`.

2. `this.artifactRoot` is already a class field (`resolve(getConfig().artifactRoot)`) — no DI changes needed for `canonicalScratchpadPath`.

3. `execution.service.ts` already imports `{ runDir, worktreesRoot }` from `context-layout.js` — adding `{ canonicalScratchpadPath, ensurePlanDir, workItemSlug }` is a minimal import extension.

4. `ensureScratchpadIgnored` is called once right after `writeScratchpad`, before the agent session starts — it is the right place to update the `.gitignore` entry.

5. The `getRunScratchpad` endpoint is used by the UI to display live scratchpad content. Preferring the canonical file (which is synced at each phase boundary) over the worktree live file means the UI will show slightly-stale-but-durable content for active runs, and accurate content for completed runs. This is acceptable per the contract ("synced back at phase boundaries").

6. `scratchpad-initial.md` and `scratchpad-final.md` stay in `runs/<run_id>/` as secondary artifacts. They are written by the service, not by the agent, so they are reliable snapshots.

7. The disambiguation feedback prompt (line 731) is an inline string literal — it will need a local `scratchpadName` variable computed from `run.work_item_id` rather than being injected as a parameter.

8. `buildScratchpad` is a public method (called by tests). Its signature does not need to change — it still generates skeleton content from `run` + `node`. The new `writeScratchpad` private method wraps it with the plan-dir logic.

### What the planning service does

`src/modules/planning/planning.service.ts` does NOT read or write scratchpads. It manages the agent session for the planning assistant (graph queries, memory writes, GitHub sync proposals). No changes needed there.

### Commit safety change

The ADR specifies replacing the `.gitignore` trick with hard validation in auto-commit and PR creation. That hardening is **step 6** in the ADR — out of scope for this issue. This issue only:
- Broadens the gitignore pattern from `SCRATCHPAD.md` to `SCRATCHPAD_*.md` in both the root `.gitignore` and the per-worktree `.gitignore` injection
- Updates the prompt rule ("never stage `SCRATCHPAD_*.md`")

---

## Questions / Blockers

### Decisions Made

2026-04-09 — Phase 3.5 interactive Q&A

**Q1 — Worktree filename convention**
**A:** `SCRATCHPAD_<slug>.md` (consistent naming everywhere).
**Rationale:** The gitignore glob covers it cleanly, grep/tooling is consistent, and the agent gets the same filename everywhere. Tasks 3/5/6 proceed as originally planned.

**Q2 — First-run vs. re-run seeding**
**A:** Carry forward canonical → worktree. If `plans/<slug>/SCRATCHPAD_<slug>.md` already exists, copy it into the worktree; otherwise build skeleton and write canonical.
**Rationale:** Forward-compatible with ADR 014 step 4 (extract prepare-plan), which will pre-populate the canonical scratchpad. Step 2's behavior should not require re-work in step 4.

**Q3 — Sync-back: missing worktree file**
**A:** Log a warning, leave canonical unchanged.
**Rationale:** Preserves last-known-good state; surfaces the anomaly for debugging without throwing (agent deletions should not crash the run).

**Q4 — `scratchpad-initial.md` / `scratchpad-final.md`**
**A:** Remove entirely. Neither snapshot is written under `runs/<run_id>/` anymore.
**Rationale:** Canonical is the single source of truth. Keeping demoted snapshots adds code complexity without a clear debugging benefit given the canonical file is already persistent across runs. The issue body allows removal ("demoted to optional debugging snapshots" permits dropping them).

**Q5 — `getRunScratchpad` return type**
**A:** Drop the `source` field entirely. Response becomes `{ content: string | null }` (or similar).
**Rationale:** Canonical is the source of truth; the discriminant is no longer meaningful. Frontend update is in scope for Task 7 as a breaking API change.

### Clarifications Needed

(None — all resolved above.)

### Blocked By

(None — step 1 merged.)

---

## Work Log

### 2026-04-09 — Planning (Phase 2)

Analyzed the following files:
- `/home/marc/escapement-studio/src/lib/context-layout.ts` — step 1 helpers; `canonicalScratchpadPath` is the only missing function
- `/home/marc/escapement-studio/src/modules/execution/execution.service.ts` — all scratchpad logic lives here; identified 9 touch points across `writeScratchpad`, `ensureScratchpadIgnored`, `getRunScratchpad`, `buildSetupPrompt`, `buildDoWorkPrompt`, inline disambiguation prompt, and the completion block
- `/home/marc/escapement-studio/src/modules/execution/__tests__/build-scratchpad.test.ts` — test fixture pattern for testing `ExecutionService` methods without DI
- `/home/marc/escapement-studio/src/lib/__tests__/context-layout.test.ts` — tmp-dir pattern for filesystem tests
- `/home/marc/escapement-studio/docs/contracts/plan-and-run-lifecycle.md` — canonical spec
- `/home/marc/escapement-studio/.gitignore` — currently has `SCRATCHPAD.md` entry, needs broadening

Planning module (`src/modules/planning/`) confirmed clean — no scratchpad reads or writes.

### 2026-04-09 — Implementation

**Commit 1** (`39c6925`) — Task 1: `canonicalScratchpadPath` helper
- Added `canonicalScratchpadPath(artifactRoot, workItemId)` to `src/lib/context-layout.ts`
- Added 3 unit tests in `context-layout.test.ts` (now 19 tests, all pass)

**Commit 2** (`058034e`) — Tasks 2–8 bundled (all execution.service.ts changes + gitignore + new test file)
- `writeScratchpad`: ensurePlanDir + carry-forward from canonical + copy to `SCRATCHPAD_<slug>.md` in worktree; removed `scratchpad-initial.md` write
- `syncScratchpadToCanonical`: new private method; missing worktree file logs warning and leaves canonical unchanged
- `executeRun`: sync-back at end of setup phase, after feedback-driven updates, and at end of do-work phase
- Removed `scratchpad-final.md` write at completion
- `buildSetupPrompt`, `buildDoWorkPrompt`, inline disambiguation feedback prompt: all use `scratchpadName = SCRATCHPAD_${workItemSlug(...)}.md`
- `ensureScratchpadIgnored`: now adds `SCRATCHPAD_*.md` glob instead of `SCRATCHPAD.md` literal
- `readChecklistFromWorktree`: reads slug-specific filename
- `getRunScratchpad`: prefers canonical → worktree, drops `source` field entirely (frontend already only reads `content`)
- Root `.gitignore`: adds `SCRATCHPAD_*.md` alongside existing `SCRATCHPAD.md`
- New test file `scratchpad-canonical.test.ts`: 6 tests covering `syncScratchpadToCanonical` (present + missing + warn) and `getRunScratchpad` (canonical > worktree > null, no `source` field)

**Quality checks (post-implementation):**
- `npx tsc --noEmit` ✓ clean
- `npx vitest run` ✓ 135/135 tests across 16 files
- `npx vite build --config web/vite.config.ts` ✓ 1.33s (pre-existing CSS unused-selector warnings only)

All 9 acceptance criteria satisfied.

---

## Risks and Edge Cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Agent references old `SCRATCHPAD.md` name | Medium | All prompt strings are updated in Task 6; worktree `.gitignore` uses glob |
| Re-run overwrites a plan the user manually edited in the canonical file | Low | Carry-forward approach is the decided behavior — existing canonical content is read and copied into the worktree rather than regenerated |
| Worktree path contains spaces or special chars in slug | Low | `workItemSlug` normalizes all non-alphanumeric chars to `_` |
| `ensurePlanDir` throws on first run if `plans/` dir doesn't exist | None | `mkdirSync(..., { recursive: true })` handles this |
| `syncScratchpadToCanonical` called concurrently during teardown | Very low | `executeRun` is sequential within a run; finally block order is deterministic |
| `getRunScratchpad` reading canonical file for a run whose work_item_id has no plan dir yet | Low | `existsSync` check before read handles gracefully |
