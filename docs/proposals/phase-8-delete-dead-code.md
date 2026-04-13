# Phase 8 — Delete dead code and rename reconciliation

**Status:** proposed
**Predecessors:** [phase-7-planner-tool-registry.md](phase-7-planner-tool-registry.md)
**Successors:** [phase-9-review-pass.md](phase-9-review-pass.md)
**Estimated effort:** 1–2 days
**Net forwardRef change:** **−1** (4 → 3)

## Motivation

Three independent cleanups that share the "make the tree match
reality" theme. None of them is architecturally complex; they exist
because dead code and misleading names aren't load-bearing enough to
block anything but accumulate cognitive tax for every new reader.
See [`assessment.md`](assessment.md) §8 (GitModule), §9
(reconciliation naming), and scattered notes about orphaned methods.

### 8.1 `GitModule` is unimported

`src/modules/git/` contains:
- `git.module.ts` (8 lines)
- `git.service.ts` (161 lines) — `discoverRepo`, `suggestArtifactRoot`,
  plus six exported pure helper functions
- `__tests__/git.service.test.ts` (~135 lines)

None of it is imported into `AppModule`. `grep -r 'GitModule\|GitService'`
finds only the three files above plus their tests. The intended
HTTP surface (a "point Studio at a local repo, get artifact root
suggestions" wizard) was never built. **It's pure dead code.**
~305 lines of dead code + tests that pass while testing nothing
that runs.

### 8.2 Two "reconcile" vocabularies

[`src/modules/reconciliation/reconciliation.service.ts`](../../src/modules/reconciliation/reconciliation.service.ts)
(181 lines) is a **drift report generator**. It compares a work
item's `predicted_files` to its `actual_files` and classifies the
difference as `no_prediction`, `no_actual_changes`, `exact_match`,
`overprediction`, `unpredicted_change`, or `mixed_drift`. It
mutates no state; it has no relation to the word "reconciliation" in
the usual sense (bringing two sources of truth into agreement).

[`src/modules/execution/work-item-reconciler.service.ts`](../../src/modules/execution/work-item-reconciler.service.ts)
(465 lines) is **actual reconciliation** — it joins graph state, on-disk
runs, GitHub PR truth, and worktree state into a derived "next action"
view per work item. It's even named correctly. But the name collision
with the other service means a new contributor opens both files
looking for related logic and finds they're unrelated.

The mechanical fix: rename `ReconciliationService` →
`DriftReportService`, `ReconciliationModule` → `DriftReportModule`,
`ReconciliationController` → `DriftReportController`, file names to
match. Keep the HTTP route `/api/reconciliation/reports` alive for
backwards compat (the frontend's `ReconciliationPanel.svelte` and the
`reconciliation_query` planner tool both hit it; changing URLs is a
breakage). The planner tool name stays `reconciliation_query` because
the LLM has the name memorized and renaming it costs context-window
stability.

### 8.3 Orphaned dead code inside live files

- `ExecutionService.createHsmRunRecord` — orphaned since Phase 1.
- `ExecutionService.buildPrompt` — legacy compat wrapper for
  `buildDoWorkPrompt`. Used only by `createRunRecord` call sites
  with no `run` context. Check if still called after Phase 4.
- `createHsmRunRecord` test in `execution/__tests__/` — tests
  dead code.
- Four unused frontend Svelte components per diagram 04's notes:
  - `web/src/components/ExecutionRunList.svelte`
  - `web/src/components/ExecutionRunListItem.svelte`
  - `web/src/components/ExecutionContextSidebar.svelte`
  - `web/src/components/WorkspaceTabs.svelte`

### 8.4 Revisit `Reconciliation → Execution` import

`ReconciliationModule` currently imports `ExecutionModule` because
`ReconciliationService` injects `ExecutionService.listRecentRuns`.
After Phase 4 extracted `RunStore`, `ReconciliationService` (now
`DriftReportService`) can inject `RunStore` directly and drop the
`ExecutionModule` import. It's not a forwardRef (neither side uses
one), but it's a direct dependency that's only needed for one read.

## Scope

**In:**

- Delete `src/modules/git/` entirely (module + service + tests).
- Rename `src/modules/reconciliation/` → `src/modules/drift-report/`:
  - `reconciliation.module.ts` → `drift-report.module.ts`
  - `reconciliation.service.ts` → `drift-report.service.ts`
  - `reconciliation.controller.ts` → `drift-report.controller.ts`
  - `types.ts` stays but renames types: `ReconciliationReport` →
    `DriftReport`, etc. (TypeScript rename refactor — one PR touches
    every consumer).
  - Update `AppModule` import.
  - Update `PlanningModule` import.
  - Keep the HTTP route as `/api/reconciliation/reports` with a
    controller-level `@Controller("api/reconciliation")`. Add a
    `// FIXME(rename)` marker so future cleanup can migrate the URL.
  - Keep the planner tool registered as `reconciliation_query`
    inside `tools/reconciliation-query.tool.ts` (renamed from Phase
    7's introduction) — both the tool name the LLM sees and the
    filename stay stable despite the service rename.
- Update the new `DriftReportService` to inject `RunStore` directly
  instead of `ExecutionService`. Remove `ExecutionModule` from
  `DriftReportModule.imports`.
- Delete `ExecutionService.createHsmRunRecord` + its test. Delete
  any other orphaned `TODO(phase-8)` entries left by Phase 1 and 4.
- Delete the four frontend components above. Update `App.svelte` and
  any barrel files that import them (there shouldn't be any — the
  diagram says they're already unreferenced).
- Delete `src/modules/execution/__tests__/disposition.test.ts` if
  its coverage was fully absorbed by
  `run-disposition.service.test.ts` in Phase 3. Check during
  implementation.
- Delete `src/modules/graph/__tests__/hsm-action-handlers.test.ts`
  if any residue survived Phase 1's move to
  `execution/__tests__/hsm-action-handlers.test.ts`.

**Out:**

- No rename of the HTTP route `/api/reconciliation/reports`.
  Frontend + planner tool coupling makes that a breaking change;
  defer to a future URL migration phase.
- No rename of the planner tool `reconciliation_query`. LLM memory
  of tool names is a real constraint and a rename would cost weeks
  of recovering from "what's the new name?" prompts.
- No rename of `WorkItemReconcilerService`. It's correctly named.
- No changes to the `DriftReportService` logic — just naming.
- No deletion of the `reconciliation_query` planner tool file. It
  stays, the file inside `tools/` stays, only the internal service
  import target updates.

## File changes

### 1. Deletions

```
rm -r src/modules/git/
rm src/modules/execution/__tests__/hsm-action-handlers.test.ts  # if residual
rm web/src/components/ExecutionRunList.svelte
rm web/src/components/ExecutionRunListItem.svelte
rm web/src/components/ExecutionContextSidebar.svelte
rm web/src/components/WorkspaceTabs.svelte
```

### 2. Reconciliation rename

```bash
# Git-friendly rename using git mv so history is preserved:
git mv src/modules/reconciliation src/modules/drift-report
git mv src/modules/drift-report/reconciliation.module.ts  src/modules/drift-report/drift-report.module.ts
git mv src/modules/drift-report/reconciliation.service.ts src/modules/drift-report/drift-report.service.ts
git mv src/modules/drift-report/reconciliation.controller.ts src/modules/drift-report/drift-report.controller.ts
```

Inside the new files:

```typescript
// drift-report.service.ts
@Injectable()
export class DriftReportService {
  constructor(
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
    @Inject(RunStore) private readonly runStore: RunStore,  // was ExecutionService
  ) {}

  listReports(workItemId?: string): DriftReport[] { ... }
  getReport(workItemId: string): DriftReport { ... }
}
```

```typescript
// drift-report.module.ts
@Module({
  imports: [GraphModule],  // only GraphModule; ExecutionModule is gone
  controllers: [DriftReportController],
  providers: [DriftReportService],
  exports: [DriftReportService],
})
export class DriftReportModule {}
```

Controller stays mapped to the same URL:

```typescript
@Controller("api/reconciliation")
export class DriftReportController {
  constructor(@Inject(DriftReportService) private readonly service: DriftReportService) {}

  @Get("reports")
  listReports(@Query("work_item_id") workItemId?: string) {
    return this.service.listReports(workItemId);
  }
}
```

Note the mismatch: class is `DriftReportController`, route prefix is
`api/reconciliation`. Add a `// FIXME(url-rename): /api/reconciliation
stays for frontend compatibility; see phase-8-delete-dead-code.md`
marker above the `@Controller` decorator.

### 3. Type renames

```typescript
// drift-report/types.ts
export type DriftPattern =
  | "no_prediction" | "no_actual_changes" | "exact_match"
  | "overprediction" | "unpredicted_change" | "mixed_drift";

export interface DriftReport { ... }   // was ReconciliationReport
export interface DriftOverlap { ... }  // was ReconciliationOverlap
// etc.
```

Callers to update:
- `src/modules/planning/planning.service.ts` — `reconciliation_query`
  tool (now in `tools/reconciliation-query.tool.ts` after Phase 7) —
  import updates only, tool name stays.
- `src/modules/planning/planning.module.ts` — import path update.
- `src/app.module.ts` — import + registration update.
- `web/src/components/ReconciliationPanel.svelte` — no change
  (backend response shape updates are type-only; JSON is unchanged).

### 4. `src/app.module.ts`

```diff
- import { ReconciliationModule } from "./modules/reconciliation/reconciliation.module.js";
+ import { DriftReportModule } from "./modules/drift-report/drift-report.module.js";

  imports: [
-   ..., ReconciliationModule, ...
+   ..., DriftReportModule, ...
  ],
```

### 5. `src/modules/execution/execution.service.ts`

Delete `createHsmRunRecord` (lines 1984–2005 in the pre-phase file,
different location after Phase 4's extraction — most likely in the
orchestrator class if any). Delete any `TODO(phase-8)` comments that
Phase 1 or 4 left as markers.

### 6. `src/modules/planning/tools/reconciliation-query.tool.ts` (rename target)

Update its import from `ReconciliationService` to `DriftReportService`,
and the dep field from `reconciliationService` to `driftReportService`.
**Do not** rename the tool itself (`name: "reconciliation_query"` stays).

## Tests

**Deleted:**
- `src/modules/git/__tests__/git.service.test.ts`
- Any orphaned test that covered `createHsmRunRecord`.

**Modified:**
- `src/modules/reconciliation/__tests__/reconciliation.service.test.ts`
  → `src/modules/drift-report/__tests__/drift-report.service.test.ts`
  (rename + update imports + inject `RunStore` instead of
  `ExecutionService` in the test harness).

**Unchanged:**
- All other tests. The rename is mechanical and shouldn't affect
  behavioural coverage.

## Acceptance criteria

- [ ] `src/modules/git/` does not exist
- [ ] `src/modules/reconciliation/` does not exist
- [ ] `src/modules/drift-report/` exists with the renamed files
- [ ] `DriftReportModule` imports `GraphModule` only (no
      `ExecutionModule`)
- [ ] `DriftReportService` injects `RunStore`, not `ExecutionService`
- [ ] `ExecutionService.createHsmRunRecord` does not exist (verify
      by grep)
- [ ] `web/src/components/ExecutionRunList.svelte` and the three
      other legacy components do not exist
- [ ] `GET /api/reconciliation/reports` still returns the same shape
- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` sums to **3**
- [ ] `npm test` passes
- [ ] Frontend builds without warnings (`vite build` in web/)
- [ ] `ReconciliationPanel.svelte` renders drift reports correctly
      (manual smoke per README step 32)
- [ ] Planner tool `reconciliation_query` still works (manual smoke
      per README step 33)

## Known remaining drift

- HTTP route `/api/reconciliation/reports` is now a name mismatch with
  the backend (`DriftReport*`) — intentionally. A `// FIXME(url-rename)`
  marker in the controller documents the choice. A future phase can
  migrate the URL and retire the legacy path, but it requires a
  coordinated frontend release.
- Planner tool name `reconciliation_query` is similarly a name
  mismatch. Same deferred rename rationale.
- If Phase 4 left `executionService.buildPrompt` as a legacy wrapper,
  Phase 8 should check whether it's still called. If not, delete it.
  If yes, leave for Phase 9 review.

## Next

[Phase 9](phase-9-review-pass.md) is the final audit: unwrap any
`forwardRef` wrappers that are no longer defending a real cycle, dedup
the run-scaffolding duplication between `ExecutionService` and
`SubAgentService`, revisit bespoke callback seams, and clean up any
stragglers the first eight phases missed.
