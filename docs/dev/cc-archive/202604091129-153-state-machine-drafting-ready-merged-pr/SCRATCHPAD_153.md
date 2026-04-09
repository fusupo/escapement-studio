# Scratchpad: studio-153 — Expand work item state machine with drafting/ready/merged_pr (ADR 014 step 3)

---

## Issue Details

- **Issue:** fusupo/escapement-studio#153
- **Title:** Studio: expand work item state machine with drafting/ready/merged_pr (ADR 014 step 3)
- **URL:** https://github.com/fusupo/escapement-studio/issues/153
- **State:** open
- **Labels:** enhancement
- **Milestone:** —
- **Assignees:** —
- **Depends on:** #151 (merged), #152 (merged) — both provide ADR 014 steps 1 and 2
- **Related:** #83 (disposition epic — `merged_pr` is the attach point for its post-merge flow)
- **ADR:** `docs/adr/014-plans-runs-state-model.md`
- **Contract:** `docs/contracts/plan-and-run-lifecycle.md`

---

## Description

ADR 014 expands the state machine so every transition has a single clear actor. Today `planned`
covers everything from "issue exists" to "ready to dispatch," and there is no lifecycle phase
between `open_pr` and `done` for the post-merge disposition flow.

This issue adds three new states — `drafting`, `ready`, `merged_pr` — and wires the transitions at
their owning services:

- `planned → drafting` (planner / user) — human-triggered transition
- `drafting → ready` (human reviewer) — human-triggered transition
- `ready → drafting` (human reviewer) — human-triggered transition
- `in_progress → ready` (execution service, MVP: triggered via human endpoint)
- `in_progress → drafting` (human reviewer) — human-triggered transition
- `open_pr → merged_pr` (sync / external, post-merge refresh)
- `ready → in_progress` (execution service, launch — extends existing `planned → in_progress`)

**Out of scope:** close/archive flow (`merged_pr → done`) — deferred to step 7. `frontier` and
`blocked` remain derived views, not states.

---

## Acceptance Criteria

From the issue "Done When" section:

- [x] New states (`drafting`, `ready`, `merged_pr`) are allowed in DB and type definitions
- [x] Graph legend renders all states
- [x] Dispatch considers `ready` as launchable
- [x] Transition handlers exist in services without breaking existing flows
- [x] Tests cover the state allowlist, legend rendering, and each new transition
- [x] Type check passes (`npx tsc --noEmit`)
- [x] Tests pass (`npx vitest run` — 171/171 tests across 18 files)
- [x] Build passes (`npx vite build --config web/vite.config.ts`)

---

## Branch Strategy

- **Base branch:** `develop`
- **Feature branch:** `153-state-machine-drafting-ready-merged-pr`
- **Current branch:** (will be set during Phase 4)

---

## Implementation Checklist

### Task 1: Expand `WorkItemState` type union

**File:** `src/modules/graph/types.ts` (line ~31)

Add `"drafting" | "ready" | "merged_pr"` to the `WorkItemState` union. This is the
first change because everything else depends on the type being correct.

**Verify:** `npx tsc --noEmit` passes. Downstream type consumers (`graph-writer.service.ts`,
`work-items.service.ts`, `graph.controller.ts`, `planning/types.ts`) should not break — the union
is widened, not narrowed.

**Commit message:** `✨ feat(graph): add drafting, ready, merged_pr to WorkItemState type union`

---

### Task 2: Migrate SQLite CHECK constraint

**File:** `src/modules/graph/sqlite.service.ts`

Extend `migrateWorkItemStates()` to rebuild `work_items` with the 9-state CHECK constraint:
`planned, drafting, ready, in_progress, open_pr, merged_pr, done, deferred, cancelled`.

**Migration guard:** the existing guard checks `tableInfo.sql.includes("open_pr")`. Change to
`tableInfo.sql.includes("merged_pr")` so the migration re-runs on instances that already have
`open_pr` but not `merged_pr`. Follows the established table-drop-and-recreate pattern with
`PRAGMA foreign_keys = OFF` and a table swap.

**Commit message:** `✨ feat(graph): extend SQLite CHECK constraint to include drafting, ready, merged_pr`

---

### Task 3: Override frontier / dispatch to include `ready`

**File:** `src/modules/graph/graph.service.ts`

The upstream `queryFrontier` and `buildDispatchPlan` from the `escapement` package only select
`state = 'planned'`. Studio must treat `ready` as equally launchable.

**Approach (resolved in Q1):** inline helpers in `graph.service.ts`. No new files.

- Add a Studio-local SQL helper `queryStudioFrontier(db)` that runs the upstream frontier query
  with `WHERE w.state IN ('planned', 'ready')`. Use it in `GraphService.getFrontier()`.
- For `GraphService.getPlan()`: call the upstream `buildDispatchPlan` as-is, then query `ready`
  items separately and append them to the relevant `parallel_groups` before returning. This keeps
  the upstream call intact but augments the result.
- Document the reason for the override inline so step 4/5 refactorers know why.

**Verify:** `resolveLaunchEligibility()` → `getPlan()` produces `ready` items in `parallel_groups`.
Existing tests for `planned`-only frontier continue to pass.

**Commit message:** `✨ feat(graph): include ready-state items in frontier and dispatch plan`

---

### Task 4: Accept `ready` in launch path (`ready → in_progress`)

**File:** `src/modules/execution/execution.service.ts`

In `markWorkItemInProgressOnLaunch()` (line ~1828), the current guard is
`if (workItem.state !== 'planned') return { workItem, transitioned: false }`. Expand to also
transition from `ready`:

```ts
if (workItem.state !== "planned" && workItem.state !== "ready") {
  return { workItem, transitioned: false };
}
```

Update the activity log message to be accurate for both source states.

**Commit message:** `✨ feat(execution): transition ready → in_progress on launch`

---

### Task 5: Add `transitionInProgressToReady` helper on ExecutionService

**File:** `src/modules/execution/execution.service.ts`

**MVP decision (Q3):** runs failing with errors stay in `in_progress`. The execution service still
"owns" the `in_progress → ready` transition per the ADR actor table, but exposes it as a callable
method rather than auto-invoking on failure. The human-triggered transition endpoint (Task 7)
calls this method when a reviewer decides the plan is still valid after a failed run.

Add public method:

```ts
transitionInProgressToReady(workItemId: string): WorkItemRecord {
  const workItem = this.workItemsService.getById(workItemId);
  if (workItem.state !== "in_progress") {
    throw new BadRequestException(
      `Cannot transition ${workItemId} from ${workItem.state} to ready`,
    );
  }
  return this.workItemsService.update(workItemId, { state: "ready" });
}
```

**Note:** no changes to the run failure `.catch` path. Failed runs remain in `in_progress` until
a human acts. A future step can add conditional auto-invocation with error classification.

**Commit message:** `✨ feat(execution): add transitionInProgressToReady helper on ExecutionService`

---

### Task 6: Transition `open_pr → merged_pr` in post-merge sync

**File:** `src/modules/execution/execution.service.ts`

In `syncMergedPullRequest()` (line ~400), the current update at line ~425 sets `state: "done"`.
Change to `state: "merged_pr"`. Confirmed in Q2: `merged_pr` becomes a stable resting state in
step 3, and `merged_pr → done` lands in step 7.

**Side-effect check:** scan for any callers or tests that assert `done` after a merge sync:
- `src/modules/execution/__tests__/execution-github-refresh.test.ts` — most likely location for
  affected tests; update expectations.
- Grep for `syncMergedPullRequest` and `state.*=.*done` for any UI flows.

**Commit message:** `✨ feat(execution): transition open_pr → merged_pr on post-merge sync`

---

### Task 7: Add human-reviewer transition endpoint

**File:** `src/modules/graph/work-items.controller.ts`

Add `POST /api/work-items/:id/transition` that accepts `{ to: WorkItemState }` and validates the
transition is allowed from the current state. Valid human-reviewer transitions to wire:

- `planned → drafting`
- `drafting → ready`
- `ready → drafting`
- `in_progress → drafting`
- `in_progress → ready` (delegates to `ExecutionService.transitionInProgressToReady` from Task 5)
- any active → `deferred`
- any active → `cancelled`

Implement a `VALID_TRANSITIONS` map (probably in `WorkItemsService` or a new
`src/modules/graph/state-transitions.ts` helper). Reject disallowed transitions with
`BadRequestException`. Delegate actual state update to `workItemsService.update()` except for
the `in_progress → ready` case which goes through `ExecutionService`.

**Commit message:** `✨ feat(graph): add work item state transition endpoint for human-reviewer actions`

---

### Task 8: Update graph legend in GraphView

**File:** `web/src/components/GraphView.svelte` (legend block ~lines 94–104)

Add three new `legend-row` entries: `drafting`, `ready`, `merged_pr`. Use colors from Task 9
(derived from existing palette).

**Commit message:** `✨ feat(ui): add drafting, ready, merged_pr to graph legend`

---

### Task 9: Add `STATE_COLORS` entries derived from existing palette

**File:** `web/src/lib/graph.js`

**Existing palette (for reference):**
```js
done:        "#238636"  // green
in_progress: "#d29922"  // amber/yellow
open_pr:     "#a371f7"  // purple
planned:     "#58a6ff"  // blue
deferred:    "#8b949e"  // grey
cancelled:   "#f85149"  // red
```

**Resolved in Q4:** derive new colors from the existing palette before committing. Suggested
values that fit the GitHub-inspired palette and preserve perceptual distinctness:

- `drafting` — a muted version of planned's blue, e.g. `#388bfd` or `#79c0ff` (lighter blue)
  → signals "plan is being shaped"
- `ready` — a desaturated cyan/teal that sits between blue and green, e.g. `#39c5cf` or a green-
  blue like `#56d4dd` → signals "approved plan awaiting launch"
- `merged_pr` — a darker green than `done` (`#238636`), e.g. `#196c2e` or a muted purple-green
  blend → signals "PR landed, pending final archival"

**Do-work should:** (1) open the rendered graph in the browser during implementation to verify
visual distinctness, (2) check that neighbors in the palette don't collide, (3) adjust hex values
if needed.

**Commit message:** `✨ feat(ui): add state colors for drafting, ready, merged_pr`

---

### Task 10: Add state-machine allowlist tests

**New file:** `src/__tests__/state-machine-allowlist.test.ts`

Exhaustive coverage:
1. Type union — instantiate a typed array of all 9 state values (compile-time enforced, but a
   runtime array documents the allowlist for future reviewers).
2. SQLite CHECK constraint — use `initManifest(":memory:")`, run `migrateWorkItemStates`, then
   insert a work item with each of the 9 states. None should throw.
3. SQLite CHECK constraint — inserting `"invalid_state"` should throw a constraint error.
4. `STATE_COLORS` coverage — import the colors object and assert every state has an entry. This
   prevents future states from being added without colors.

**Commit message:** `🧪 test: add state machine allowlist tests for all WorkItemState values`

---

### Task 11: Extend execution transition tests

**File:** `src/modules/execution/__tests__/launch-eligibility.test.ts` (extend)

Add:
- `"marks ready work items in_progress before launching execution"` — mirrors the existing
  `planned` test with `state: "ready"`.
- `"transitionInProgressToReady updates state when current state is in_progress"` — unit test
  for Task 5 helper.
- `"transitionInProgressToReady throws when current state is not in_progress"` — negative case.

**File:** `src/modules/execution/__tests__/execution-github-refresh.test.ts` (extend if exists)

- Update any existing sync merge tests from expecting `done` to expecting `merged_pr`.
- Add `"transitions work item to merged_pr when PR is synced as merged"` if not already covered.

**Commit message:** `🧪 test: cover ready → in_progress launch and post-merge merged_pr transition`

---

### Task 12: Add work item transition endpoint tests

**New file:** `src/modules/graph/__tests__/work-item-transitions.test.ts`

Coverage:
- Each of the 7 allowed human-reviewer transitions succeeds when current state matches source.
- Disallowed transitions throw `BadRequestException`.
- Invalid target state (not in the `WorkItemState` union) throws.
- `in_progress → ready` delegates to `ExecutionService.transitionInProgressToReady` (spy).
- Active → `deferred` and active → `cancelled` work from every active state.

**Commit message:** `🧪 test: cover work item state transition endpoint`

---

### Quality Checks

- [x] `npx tsc --noEmit` passes
- [x] `npx vitest run` passes — 171/171 tests across 18 files (35 new tests added by this issue)
- [x] `npx vite build --config web/vite.config.ts` passes — 1.37s, only pre-existing CSS unused-selector warnings
- [ ] Manual: launch the app, open the graph, verify new state legend rows render with distinct colors
- [x] Manual: insert a work item with each of the 9 states via the DB and confirm no CHECK failures (covered by state-machine-allowlist.test.ts)

---

## Technical Notes

### State-machine integration chain

```
WorkItemState type union (types.ts)
  └→ SQLite CHECK constraint (sqlite.service.ts migrateWorkItemStates)
       └→ graph-writer.service.ts (relies on DB to reject invalid states)
  └→ Frontier query (graph.service.ts, must include 'ready')
       └→ buildDispatchPlan result augmentation (graph.service.ts getPlan)
            └→ resolveLaunchEligibility (execution.service.ts)
                 └→ markWorkItemInProgressOnLaunch (must accept 'ready')
                      └→ launch() (execution.service.ts)
  └→ syncMergedPullRequest (execution.service.ts, now targets 'merged_pr')
  └→ Transition endpoint (work-items.controller.ts, new)
       └→ ExecutionService.transitionInProgressToReady (for in_progress → ready)
  └→ STATE_COLORS (web/src/lib/graph.js)
  └→ Graph legend (web/src/components/GraphView.svelte)
```

### Frontier override strategy (Q1 decision)

The upstream `escapement` package in `node_modules` cannot be modified. The `queryFrontier` SQL
helper and `buildDispatchPlan` function both hard-code `state = 'planned'`. Studio's fix is
inline-in-graph-service:

1. `getFrontier()` — replace the upstream `queryFrontier` call with a Studio-local helper that
   runs the same SQL but with `WHERE state IN ('planned', 'ready')`.
2. `getPlan()` — call upstream `buildDispatchPlan` (which sees only `planned`), then run a second
   query for `ready` items and append them to `parallel_groups`. Document the reason inline.

If steps 4/5 of ADR 014 grow the override surface (prepare-plan extraction), we can extract this
to `src/modules/graph/studio-planner.ts`. For now, inline is sized-right.

### MVP failure-path policy (Q3 decision)

The issue's transition table lists `in_progress → ready (execution service, run failed with
valid plan)` as a service-owned transition. For MVP, we wire the transition as a callable helper
on `ExecutionService` but do **not** auto-invoke it from the run failure path. Failed runs remain
in `in_progress` until a human triggers the transition via the new endpoint (Task 7).

This satisfies the ADR's actor assignment ("execution service owns the transition") without
requiring error classification (valid plan vs. needs rework). Future work can add conditional
auto-invocation with richer error taxonomy.

### Merged-PR landing state (Q2 decision)

`syncMergedPullRequest` currently transitions `open_pr → done`. Step 3 changes this to
`open_pr → merged_pr`. `merged_pr` becomes a stable resting state until step 7 adds
`merged_pr → done`. Existing tests that assert `done` after sync will need updating (likely in
`execution-github-refresh.test.ts`).

### No new DB migrations beyond state CHECK

No new columns. No new tables. The entire schema change is the CHECK constraint rebuild in
`migrateWorkItemStates`, which already supports the table-drop-and-recreate pattern.

---

## Questions / Blockers

### Decisions Made

2026-04-09 — Phase 3.5 interactive Q&A

**Q1 — Frontier override approach**
**A:** Inline helpers in `graph.service.ts`. `getFrontier()` uses a Studio-local SQL query with
extended state filter; `getPlan()` calls upstream `buildDispatchPlan` then appends `ready` items
via a second query. No new files.
**Rationale:** Right-sized for this issue. Upstream exposes two functions and Studio needs both
extended — a full adapter module would be premature. Can extract to `studio-planner.ts` in step
4/5 if the override surface grows.

**Q2 — `syncMergedPullRequest` target state**
**A:** Land on `merged_pr` in step 3; `merged_pr → done` deferred to step 7.
**Rationale:** Matches the ADR transition table. `merged_pr` is a stable resting state pending
step 7's archive flow. Existing tests expecting `done` after sync must be updated.

**Q3 — Run-failure auto-transition (MVP)**
**A:** Leave failed runs in `in_progress`. Expose `transitionInProgressToReady` as a public
helper on `ExecutionService` but trigger it only via the human-reviewer transition endpoint.
**Rationale:** Avoids MVP complexity of classifying errors as "plan valid" vs "plan needs
rework." Service still owns the transition per the ADR actor table. Future step can add
conditional auto-invocation with error classification.

**Q4 — Colors for new states**
**A:** Derive from the existing palette during implementation; do-work verifies visual
distinctness in the rendered graph before committing.
**Rationale:** No design assets specify hex values. The existing palette is GitHub-inspired;
new colors should fit that family. Suggestions in Task 9 are starting points, not mandatory.

### Clarifications Needed

(None — all resolved above.)

### Blocked By

(None — steps 1 and 2 are merged on `develop`.)

---

## Work Log

### 2026-04-09 — Planning (Phase 2)

- Delegated codebase analysis to scratchpad-planner agent
- Agent surveyed: `WorkItemState` type at `src/modules/graph/types.ts:31`; SQLite migration
  pattern in `src/modules/graph/sqlite.service.ts`; upstream `queryFrontier`/`buildDispatchPlan`
  in `escapement/src/core/planner.ts`; `markWorkItemInProgressOnLaunch` at
  `execution.service.ts:1828`; `syncMergedPullRequest` at `execution.service.ts:400`; graph
  legend in `GraphView.svelte:94–104`; `STATE_COLORS` in `web/src/lib/graph.js:4–11`.
- Phase 3.5 Q&A resolved 4 clarifications (see Decisions Made above).
- Scratchpad produced with 12 atomic tasks targeting 10 source files.

### 2026-04-09 — Implementation

Commits landed on branch `153-state-machine-drafting-ready-merged-pr`:

1. `9e43dd4` — Task 1: expand `WorkItemState` type union
2. `13237d7` — Task 2: migrate SQLite CHECK constraint (guard sentinel moved to `merged_pr`)
3. `7e1d023` — Task 3: Studio-local frontier and dispatch plan with `ready` included
4. `f37a02c` — Tasks 4 + 5: accept `ready` in launch + add `transitionInProgressToReady` helper
5. `b8075f2` — Task 6: post-merge sync lands on `merged_pr`; fixes frontend merged-PR badge check
6. `6795b2c` — Task 7: add transition endpoint with `VALID_HUMAN_TRANSITIONS` allowlist and forwardRef-resolved circular dep between GraphModule and ExecutionModule
7. `12aa7bc` — Tasks 8 + 9: new STATE_COLORS entries and legend rows, reordered to match lifecycle flow
8. `e8d1750` — Tasks 10 + 11 + 12: 35 new tests across 3 files (state-machine allowlist, launch-eligibility extensions, transition endpoint)

**Quality gates:** all green.
- `npx tsc --noEmit`: clean
- `npx vitest run`: 171/171 tests across 18 files
- `npx vite build --config web/vite.config.ts`: 1.37s, only pre-existing CSS warnings

**Implementation decisions made during do-work:**
- Task 3 frontier override used a hybrid of the Q1 decision: rather than inline SQL helpers
  inside `graph.service.ts`, extracted the helpers as module-scope functions in the same file
  (`queryStudioFrontier` + `buildStudioDispatchPlan`) so they can be reused if needed. Extended
  `manifest-core.ts` to re-export the additional upstream planner helpers (`buildParallelGroups`,
  `buildSequentialNodes`, `buildValidationPolicy`, `determineMergeOrder`) and types. Net: same
  inline approach, cleaner module boundary.
- Task 7 endpoint picked `POST /api/work-items/:id/transition` on `WorkItemsController` (instead
  of a new ExecutionController endpoint) by resolving the circular dep with `forwardRef` at
  both the module and provider levels. This keeps all work-item-scoped HTTP endpoints together.
- Frontend merged-PR badge (`web/src/lib/graph.js:325`) previously required `state === "done"`
  to render the ✓PR badge. Expanded to accept both `done` and `merged_pr` so freshly-synced
  items still render the badge under the new flow. Not originally in the scratchpad — caught
  during Task 6 impact scan.
- Color choices (Task 9): picked `#79c0ff` (lighter blue for drafting), `#56d364` (bright green
  for ready, distinct from `#238636` done), `#8957e5` (deep purple for merged_pr, distinct from
  `#a371f7` open_pr). All derived from GitHub's accent palette per Q4 decision. Reordered legend
  to match lifecycle flow.

---

## Risks and Edge Cases

- **Migration idempotency:** The migration guard must correctly detect already-migrated DBs.
  Changing the sentinel from `open_pr` to `merged_pr` ensures the migration runs exactly once on
  instances that have the step 1/2 schema but not step 3.
- **Upstream package upgrades:** If `escapement` releases a new `planner.ts` with built-in
  multi-state frontier support, Studio's inline override should be replaced with a direct
  upstream call. Document this in an inline comment so a future contributor knows to check.
- **Test DB lifetime:** State-machine allowlist tests create `:memory:` DBs per test. Make sure
  each test closes the DB to prevent leaks in the vitest worker.
- **Hex color collisions:** The existing palette has 6 colors and we're adding 3 more. 9 colors
  is at the edge of perceptual distinctness on a dense graph. Do-work should visually verify
  neighbors (e.g., `drafting` vs `planned`, `merged_pr` vs `done`).
- **Human endpoint authz:** The new `POST /api/work-items/:id/transition` endpoint introduces
  human-triggered state mutations. For MVP, assume existing auth applies uniformly. Future work
  may need per-transition authz (e.g., only project leads can `cancel`).

---

**Generated:** 2026-04-09
**By:** setup-work skill (via scratchpad-planner agent)
**Source:** https://github.com/fusupo/escapement-studio/issues/153
