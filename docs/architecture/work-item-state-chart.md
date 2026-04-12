# Work-item state chart

`src/modules/graph/work-item.scxml` is the canonical Studio work-item lifecycle definition for the SCION/HSM epic.

The checked-in diagram at [`docs/architecture/work-item-state-chart.svg`](./work-item-state-chart.svg) is a reviewer aid rendered from that SCXML source. Future runtime integration should read the SCXML, not re-encode the lifecycle in ad hoc enums or transition tables.

## State vocabulary

### `pre_pr` composite

`pre_pr` groups the lifecycle states that exist before a pull request is opened.

- `planned` — the issue exists, but drafting has not started yet
- `drafting` — a background plan drafter is running or the draft is otherwise being revised
- `ready` — the draft plan is approved and dispatchable
- `in_progress` — a run is actively executing against the approved plan
- `run_errored` — the most recent run terminated in an error state and needs triage

### Top-level post-`pre_pr` states

- `open_pr` — a pull request exists and is waiting on external GitHub outcomes
- `merged_pr` — the pull request merged and is waiting for finalization
- `closed` — the pull request was closed without merge
- `deferred` — the work item is paused and can later resume through shallow history

### Terminal states

- `done` — finalized without archiving the run bundle
- `archived` — finalized with archived run artifacts on disk
- `cancelled` — the work item was explicitly abandoned

## Event vocabulary

### `user.*`

Human-initiated lifecycle events.

- `user.start_draft`
- `user.dispatch`
- `user.finalize`
- `user.archive_and_finalize`
- `user.defer`
- `user.undefer`
- `user.cancel`
- `user.retry`

### `draft.*`

Async plan-drafter completion signals.

- `draft.completed`
- `draft.failed`

### `run.*`

Execution-run outcomes projected into the work-item machine.

- `run.completed`
- `run.failed`

### `gh.*`

External GitHub state changes.

- `gh.pr_merged`
- `gh.pr_closed`
- `gh.pr_reopened`

## Entry, exit, and guard hooks

The chart now declares the side-effect seams that the runtime wires into the interpreter.

### Entry actions

- `kickOffPlanDrafter()` — on entry to `drafting`; starts the async drafter invoke
- `createRunRecord()` — on entry to `in_progress`; persists a new execution run record
- `stampMeta('studio_post_merge_sync')` — on entry to `merged_pr`; captures the merge event payload into work-item meta
- `runArchiver()` — on entry to `archived`; archives run artifacts into `archives/<slug>/`

### Exit actions

- `closeGhIssue()` — on exit from `merged_pr`; closes the linked GitHub issue before finalization completes

### Guards

- `prExistsForBranch` — splits `run.completed` from `in_progress` into either `open_pr` or back to `ready`

## Defer/resume via `pre_pr` shallow history

The chart intentionally models defer as a top-level pause state instead of duplicating `deferred` under every pre-PR child state.

Mechanics:

1. While the work item is in any `pre_pr` child state, `user.defer` transitions to top-level `deferred`
2. `pre_pr_history` remembers the last active direct child of `pre_pr`
3. `user.undefer` from `deferred` targets `pre_pr_history`
4. The item resumes at the remembered child state (`drafting`, `ready`, `in_progress`, etc.) instead of resetting to `planned`

## Why runs are separate entities

The work-item chart does **not** embed the full run lifecycle.

Instead:

- runs remain separate entities with their own statuses (`queued`, `running`, `completed`, `error`, ...)
- the work-item HSM consumes only the run outcomes that matter at the work-item level
- those outcomes enter the chart as `run.*` events (`run.completed`, `run.failed`)

This keeps concerns separated:

- the run machine describes one execution attempt
- the work-item machine describes the durable lifecycle of the underlying unit of work

## Source of truth and authoring notes

- Canonical source: `src/modules/graph/work-item.scxml`
- Reviewer diagram: `docs/architecture/work-item-state-chart.svg`
- The SCXML uses the standard SCXML namespace with `datamodel="ecmascript"`
- Inline XML comments in the SCXML explain each state's role for downstream readers

Author-time validation used for this phase:

- `xmllint --noout src/modules/graph/work-item.scxml`
- schema validation remains author-time/manual for now rather than a committed CI script
- a local target-walk check to verify every transition target resolves, including `../open_pr` and `pre_pr_history`

Diagram generation is reproducible via:

- `npm run generate:work-item-state-chart`

That command runs `scripts/generate-work-item-state-chart.py`, which parses the committed SCXML, emits a Graphviz representation, and writes `docs/architecture/work-item-state-chart.svg`.
