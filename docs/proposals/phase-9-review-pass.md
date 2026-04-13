# Phase 9 — Review pass: unwrap, dedup, document

**Status:** proposed
**Predecessors:** [phase-8-delete-dead-code.md](phase-8-delete-dead-code.md)
**Successors:** none — this is the tail of the migration.
**Estimated effort:** 2–3 days (bounded by findings)
**Net forwardRef change:** **−1 to −3** (3 → 0–2)

## Motivation

After Phases 0–8, the structural work is done: the god class is
extracted, the shadow vocabulary is deleted, the command and event
buses are installed where they're genuinely useful, infrastructure
lives in a platform module, the planner tools are per-file, the
dead module is gone, and the reconciliation naming is honest.

Phase 9 is the intentionally-loose cleanup pass that handles
everything the earlier phases deferred with "Phase 9 decides" or
"review pass revisits." Some of it is mechanical, some of it requires
judgment. It is the **only** phase with a variable acceptance target
— if the findings look bigger than expected, it spawns follow-up
issues rather than stretching into a multi-week rewrite.

## Scope — seven audits

Each audit is its own slice. Land them as separate commits on the
same PR, or as separate PRs bundled under a single epic if any one
audit grows beyond a day.

### 9.1 Unwrap redundant forwardRefs

After Phases 1–8, run a full forwardRef audit:

```bash
grep -rn 'forwardRef(' src/modules/
```

For each remaining wrapper, trace the cycle it's defending. If no
cycle exists (because an earlier phase broke it transitively),
unwrap. If a cycle does exist, ask: is the cycle necessary or is it
the residue of a wrong-home provider that nobody migrated?

Expected remaining forwardRefs after Phase 8: **3**. Likely
candidates for unwrap:

- `ExecutionModule → forwardRef(GraphModule)` — still needed because
  `ExecutionService.hsmService` and `.workItemsService` are graph-
  owned AND `RunDispositionService` dispatches to the HSM. No obvious
  way to break without moving `WorkItemHsmService` itself, which
  would be a structural rethink.
- `ExecutionModule → forwardRef(GitHubModule)` — after Phase 6 moved
  `GitHubBatchCache` to `GitHubModule`, `GitHubModule` imports
  `GraphModule` directly, and `ExecutionModule` imports
  `forwardRef(GitHubModule)` because `ExecutionService.githubService`
  is needed. Whether this is a real cycle depends on whether
  `GitHubModule → GraphModule` is still the only path. If `GraphModule`
  no longer imports anything (post Phases 1+2), then there's no
  cycle and this `forwardRef` is defensive residue. **Unwrap.**
- `PlansModule → forwardRef(GraphModule)` — likely still needed
  because `PlansService.hsmService` is graph-owned and `GraphModule`
  has no way to avoid transitively touching Plans. Check.
- `PlansModule → forwardRef(GitHubModule)` — same rationale as
  `ExecutionModule → forwardRef(GitHubModule)`. If GitHub's only
  inbound is from PlanningModule (direct), the cycle is broken and
  Plans can unwrap. **Unwrap if possible.**
- `ExecutionModule → forwardRef(PlansModule)` — after Phase 5's
  `WorkItemDeletedEvent`, was this supposed to be gone? Re-verify.

Target: **≤1 forwardRef after Phase 9**, ideally zero. Document any
surviving ones with an inline comment explaining the cycle.

### 9.2 Dedup run-scaffolding between `RunStore` and `SubAgentService`

Phase 4 extracted `RunStore` as the owner of the execution run
buffer + disk persistence. `SubAgentService` at
[`src/modules/planning/sub-agent.service.ts`](../../src/modules/planning/sub-agent.service.ts)
has a **parallel implementation** of the same responsibilities for
its own `SubAgentRunRecord` buffer (12 entries cap, `upsertRecentRun`,
`writeMetadata`, `writeStatus`, `writeSummary`, `appendEvent`, the
whole runs/<id>/ artifact contract). See
[`assessment.md`](assessment.md) §11.

Two options:

**Option A: extract a generic `RunArtifactStore<T>` base class.** `RunStore`
and `SubAgentService`'s internal store both extend it. Pure
refactor, medium surface area. Risk: base class generalizes across
two known cases but the third consumer (future) may not fit.

**Option B: leave them duplicated and accept the tax.** Document the
duplication as a known issue. Fix when a third consumer shows up.

Phase 9 recommendation: **Option B unless the team explicitly wants
A.** Phase 9 is a cleanup, not a speculative abstraction. The
duplication is ~150 lines across two files; the cost is real but
bounded. File a follow-up issue in `docs/proposals/` if anyone wants
to revisit.

### 9.3 Revisit the `ExecutionService.registerPullRequestTruthRefresher` callback

Phase 5 replaced this with `PullRequestTruthRefreshedEvent`.
Verify: is the event dispatched from exactly the same sites as the
callback used to fire? Is any subscriber missing? Is the event
fired before or after the work item meta is updated (the callback
ran after)?

If the event semantics have drifted from the callback semantics, fix
the subscriber to match. Document the final contract in a comment
on the event class.

### 9.4 Rename `ExecutionService` if it's still misleading

After Phase 4, `ExecutionService` is the orchestrator: `launch`,
`executeRun`, the transition wrappers, and a pile of convenience
getters that delegate to sub-services. "Execution service" still
fits in a loose sense, but some readers may prefer
`ExecutionRunnerService` or `ExecutionOrchestrator`.

Rename iff:
1. The new name is obviously clearer to someone reading the code
   cold
2. The rename doesn't introduce a cross-module naming collision
3. The test suite renames cleanly

Otherwise leave it. A rename that requires convincing the reader
isn't worth the diff.

### 9.5 Delete `transitionInProgressToReady` / `transitionInProgressToDrafting`

These are thin HSM dispatch wrappers that live on `ExecutionService`
because of legacy reasons. Each is ~20 lines. They exist because
`WorkItemsController`'s `routeInvestigate` / `routeStartDraft` used
to call them directly before Phase 2 routed everything through
commands.

After Phase 2, the command handlers are
`TransitionInProgressToReadyHandler` and
`TransitionInProgressToDraftingHandler`. They still delegate to the
`ExecutionService` methods. Phase 9 option: inline the HSM dispatch
into the handler `execute` bodies directly and delete the
`ExecutionService` methods.

Trade-off: the handler becomes a few lines longer, but
`ExecutionService` loses two more methods.

Recommendation: do it if the total diff is under ~80 lines. Skip
otherwise.

### 9.6 Check for the `user.resolve_disambiguation` dead HSM transition

[`work-item.scxml`](../../src/modules/graph/work-item.scxml) has a
transition `run_errored → ready` on `user.resolve_disambiguation`
that nothing dispatches at runtime. See [`assessment.md`](assessment.md)
§4.2 for the diagnosis.

Options:
- **Delete the transition** from the chart + the event type from
  `types.ts` + the test case for it. Keeps the chart honest.
- **Wire it up** — add an HTTP endpoint that dispatches the event
  from the operator UI when they decide a failed run's
  disambiguation was recoverable.

Phase 9 picks based on whether the feature is actually wanted. If
no, delete. If yes, it's a feature, not a cleanup — file an issue
and defer.

### 9.7 Ratify a service-size convention

[`assessment.md`](assessment.md) §10 and the "default to a god
class" discussion after that flag a pattern concern: multiple
services grew past 1000 lines before extraction was forced. A
written convention reshapes the next decision rather than the last.

Add to `CLAUDE.md` (and `AGENTS.md` if it exists):

```
Service size convention:
- Services stay under ~400 lines where practical.
- When a service crosses ~600 lines, open an issue to extract a
  sub-service on the next feature that would grow it further.
- God classes (>1000 lines) are a code smell, not a design goal.
  Controllers should be thin. Orchestrator classes that coordinate
  sub-services are fine; service classes that own multiple
  unrelated responsibilities are not.
```

Not a hard rule. A forcing function for the next decision.

## Acceptance criteria

- [ ] `grep -c 'forwardRef(' src/modules/*/*.module.ts` sums to
      **≤1**, ideally **0**. Any surviving forwardRef has an
      inline comment explaining the cycle it defends.
- [ ] Audit 9.2 decision documented (option A or B chosen, with
      rationale in this phase doc or a follow-up issue).
- [ ] `PullRequestTruthRefreshedEvent` dispatch sites verified
      against the pre-Phase-5 callback dispatch sites — no
      behavioural drift.
- [ ] Either `ExecutionService` is renamed OR this phase doc
      explicitly records "kept as-is" with rationale.
- [ ] Either `user.resolve_disambiguation` is deleted from the
      chart OR a follow-up issue tracks its implementation.
- [ ] `CLAUDE.md` contains the service-size convention.
- [ ] `npm test` passes.
- [ ] Server boots and all end-to-end smoke flows from README still
      pass (steps 1–41).
- [ ] The `docs/proposals/` README phase table has its "Status"
      column updated — every phase through 9 either `landed` or
      `deferred` with a reason.

## Known remaining drift (after Phase 9)

If anything is still structurally off after Phase 9, it belongs in a
follow-up epic, not a stretch of this phase. Known candidates for
future work:

- **Async plan drafting.** ADR 015 promised SCXML `<invoke>` for
  `kickOffPlanDrafter`, which was never built. The synchronous path
  inside `PlansService.prepare` is ops-visible (long HTTP requests
  when the LLM stalls). A future phase could implement `<invoke>`
  semantics in `WorkItemHsmService` or switch to a fire-and-forget
  `DraftPlanCommand` + `DraftCompletedEvent` pair.
- **Durable event sourcing.** `@nestjs/cqrs` events are in-process,
  synchronous, and swallow errors. If a subscriber becomes
  load-bearing, the right fix is an outbox pattern + durable queue,
  not retrofitting the existing EventBus.
- **URL rename for `/api/reconciliation/reports`.** Held back in
  Phase 8 for frontend + planner-tool stability. Revisit when a
  frontend refactor is happening anyway and the cost is lower.
- **Frontend component cleanup.** Phase 8 deletes four legacy
  components. The remaining frontend structure may have its own
  smells (e.g. `App.svelte` state management) that are out of scope
  for this migration.
- **Test harness patterns.** Multiple tests use
  `Object.create(ServicePrototype)` to bypass Nest DI. Works but
  fragile. A test-infrastructure cleanup phase could introduce a
  `createTestService(ServiceClass, { overrides })` helper.

Each of these is a standalone issue. None blocks anything.

## The end of the migration

At the end of Phase 9, the backend satisfies the target shape:

- Services are right-sized; god classes are gone.
- Module boundaries are clean; forwardRefs are ≤1.
- Shadow vocabulary is deleted; tests validate what runs.
- Platform concerns (SQLite) live in a platform module.
- External-state concerns (GitHub cache) live with their domain.
- HTTP adapters route through the command bus when they cross
  module boundaries.
- Cross-context notifications use events where fire-and-forget is
  adequate.
- The planner tool registry is per-file.
- Naming matches meaning.
- CLAUDE.md has a forcing-function convention for future growth.

NestJS is still the runtime. No feature was frozen. Every phase
landed as a single reviewable PR. The tests are a safety net again.

Read `docs/proposals/assessment.md` one more time and verify the
smells it identified are all either resolved or tracked in a
follow-up. File the follow-ups. Close the epic.

## Next

**None.** Phase 9 closes the migration. Future improvements live
in standalone issues, not in this proposals tree.
