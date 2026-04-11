# ADR 015: Hierarchical state machine (SCION SCXML) for work item lifecycle

- **Status:** accepted
- **Date:** 2026-04-11

## Decision

Adopt **SCION-CORE** (a W3C SCXML-conformant interpreter) as the sole engine for work item lifecycle transitions. Author the lifecycle as a hierarchical state chart committed at `src/modules/graph/work-item.scxml` and treat that file as the canonical source of truth for what transitions are legal, what actions fire on entry/exit, and what events the system accepts.

All state transitions route through `WorkItemHsmService.dispatch(workItemId, event)`. Direct writes to `work_items.state` are forbidden outside of `WorkItemsService.unsafeSetState`, which exists solely as an escape hatch for migration tooling and is grep-able for future cleanup.

Key structural choices in the chart:

- **Composite `pre_pr` parent state** contains `planned`, `drafting`, `ready`, `in_progress`, `run_errored`. Shared transitions (`gh.pr_opened`, `user.cancel`, `user.defer`) are declared once at the parent and inherited by every substate.
- **SCXML `<history>` element** inside `pre_pr` enables defer/resume: `user.defer → deferred`, then `user.undefer → pre_pr_history` restores exactly the substate the work item was in before deferral.
- **Runs remain a separate entity** with their own plain-field `status` (`queued → preparing → running → { completed | error | blocked | disambiguating }`). The work item HSM is deliberately agnostic about intra-run state; only terminal run events (`run.completed`, `run.error`) cross the boundary into the work item HSM.
- **GitHub is an external, intercommunicating state machine** observed via `GitHubBatchCache`. The work item HSM consumes `gh.*` events emitted by the observer but never represents GitHub's internal transitions explicitly.
- **Three auto-transitioning event sources** populate the HSM's event queue: the run entity (`run.*`), the GH observer (`gh.*`), and the plan drafter (`draft.*`). User actions contribute a fourth (`user.*`).
- **Entry/exit actions** (`createRunRecord`, `stampMeta(…)`, `closeGhIssue`, `runArchiver`) are synchronous and run inline during dispatch. `kickOffPlanDrafter` is asynchronous via SCXML `<invoke>`: entering `drafting` spawns a background drafter task; the HTTP request returns immediately; the task later dispatches `draft.completed` / `draft.failed` back into the HSM.

The state vocabulary from ADR 014 is preserved and extended. Added: `closed` (GH issue closed, execution awaiting finalize), `run_errored` (run failed, user needs to retry or investigate), `archived` (terminal state with an archive bundle on disk). `done` is redefined as "finalized without archive" — the terminal path when the user chooses not to archive.

Detailed spec in #198 (HSM epic) and child phase issues #199–#203. Chart authored in #199.

## Rationale

- **Flat enum + imperative writes scales poorly.** ADR 014 introduced a flat state vocabulary and left transitions to whichever service method needed to change state. In practice: transition logic is scattered, legality is implicit, cross-cutting events (cancel/defer from any pre-PR state) force per-state duplication, and adding a state means hunting down every call site.
- **Explicit state chart = single source of truth.** A committed SCXML file is a load-bearing architecture artifact: reviewable, diff-able, renderable as a diagram, and directly executable by a conformant interpreter. Arguments about "what's the right transition here" resolve by reading the chart.
- **SCION specifically over XState.** SCION-CORE implements the W3C SCXML specification, so the chart is portable, spec-valid XML. XState is more ergonomic and has richer devtools but is entangled with XState Inc's hosted Stately offering and the associated commercial positioning. For a local-first tool, W3C conformance and vendor independence matter more than visual editor UX.
- **Composite states and history states match the problem shape.** The `pre_pr` grouping and defer-via-history pattern fall out naturally and remove real code — they aren't theoretical wins.
- **Declarative entry actions for meta audit.** `studio_open_pr_sync`, `studio_post_merge_sync`, `studio_issue_close_sync` meta blocks are now stamped by SCION entry actions, not by ad-hoc imperative code spread across services. Same behavior, one place to change it.
- **Events as the sole transition driver.** Adding a new trigger (timer, webhook, CLI tool, another service) becomes purely additive: dispatch the right event and the HSM does the rest. No new transition logic per producer.
- **Testing exhaustively becomes cheap.** Chart tests enumerate `(state, event) → state` pairs and run against a pure interpreter — much more coverage than the ad-hoc "test each service method" style.

## Consequences

- **ADR 014 is extended, not superseded.** Plans-vs-runs separation, canonical scratchpad layout, issue-backed V1 scope, and the original state vocabulary all remain valid. The implicit "imperative state writes are fine" assumption in 014 is the only part replaced.
- **Every service that wrote `work_item.state` directly must be migrated** to `WorkItemHsmService.dispatch` (tracked in #201). Until migration is complete, the two mechanisms coexist and can drift; this is a transitional hazard that must be closed out.
- **`WorkItemsService.update` loses its `state` field.** `unsafeSetState(id, state, reason)` is the escape hatch, used only by migration scripts. Each call logs a warning so future cleanup can grep for residue.
- **Reconciler is no longer a state writer.** It becomes an event source: observe `GitHubBatchCache`, dispatch `gh.*` events into the HSM, return the reconciled view. The `GitHubDerivedStateApplier` originally drafted in #192 Phase 3 (#195) is superseded by the HSM interpreter itself — #195 closed as such.
- **Frontend disposition rendering switches from `next_action` to HSM `enabled_events`.** The reconciled row exposes the set of `user.*` events the HSM will accept from the current state; the frontend maps events to button labels. Adding a new user action is "declare the transition in the chart + add the event→label entry."
- **SCION-CORE becomes a runtime dependency.** A malformed `work-item.scxml` fails server startup loudly — a bad chart takes the whole lifecycle down, which is the right failure mode for a load-bearing artifact.
- **The chart file is code review–critical.** Changes to `work-item.scxml` are reviewed with the same rigor as changes to the schema or public API: they are public contract.
- **`merged_pr → done/archived` transitions stop being imperative.** `closeGhIssue` becomes an exit action on the `merged_pr` state — declared in the chart, executed by SCION. The guard relaxation that originally motivated #196 becomes implicit: both `merged_pr` and `closed` declare the same user transitions, so the service code doesn't branch on current state.
- **Schema migration required for state column.** Phase 1 (#193) relaxes the SQLite CHECK to accept the expanded vocabulary. The dotted-leaf-path storage format (`pre_pr.in_progress`) is introduced in Phase 2 (#200) when the SCION interpreter needs to rehydrate.
- **Supersedes the draft "GitHubDerivedStateApplier" direction** captured briefly in #195. The batch-sync epic (#192) itself survives — its cache and timer infrastructure feed the HSM — but its Phase 3 is absorbed into the HSM epic.
