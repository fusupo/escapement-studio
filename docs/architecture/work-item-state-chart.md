# Work-item state chart

`src/modules/graph/work-item.scxml` is the canonical Studio work-item lifecycle definition for the SCION/HSM epic.

The checked-in diagram at [`docs/architecture/work-item-state-chart.svg`](./work-item-state-chart.svg) is a reviewer aid rendered from that SCXML source. Future runtime integration should read the SCXML, not re-encode the lifecycle in ad hoc enums or transition tables.

## State vocabulary

### `pre_pr` composite

`pre_pr` groups the lifecycle states that exist before a pull request is opened.

- `planned` — the issue exists, but drafting has not started yet
- `drafting` — the canonical scratchpad is being written or revised
- `ready` — the draft plan is approved and dispatchable
- `in_progress` — a run is actively executing against the approved plan
- `run_errored` — the most recent run terminated in an error state and needs triage

### Top-level post-`pre_pr` states

- `open_pr` — a pull request exists and is waiting on external GitHub outcomes
- `merged_pr` — the pull request merged and is waiting for human disposition
- `closed` — the pull request was closed without merge
- `deferred` — the work item is paused and can later resume through shallow history

### Terminal states

- `done` — disposition completed without archiving the plan dir
- `archived` — disposition completed with archival
- `cancelled` — the work item was explicitly abandoned

## Event vocabulary

The SCXML uses namespaced event families so later integration phases can map different actors into the chart cleanly.

### `draft.*`

Planning and review events.

- `draft.start`
- `draft.approve`
- `draft.discard`
- `draft.reopen`
- `draft.revise_after_error`

### `run.*`

Execution-run outcome events projected into the work-item machine.

- `run.launch`
- `run.pr_opened`
- `run.retry_ready`
- `run.retry_drafting`
- `run.errored`

### `gh.*`

External GitHub state changes.

- `gh.pr_merged`
- `gh.pr_closed`
- `gh.pr_reopened`

### `user.*`

Explicit human disposition / control actions.

- `user.defer`
- `user.undefer`
- `user.retry`
- `user.close`
- `user.archive`
- `user.cancel`

## Defer/resume via `pre_pr` shallow history

The chart intentionally models defer as a top-level pause state instead of duplicating `deferred` under every pre-PR child state.

Mechanics:

1. While the work item is in any `pre_pr` child state, `user.defer` transitions to top-level `deferred`
2. `pre_pr_history` remembers the last active direct child of `pre_pr`
3. `user.undefer` from `deferred` targets `pre_pr_history`
4. The item resumes at the remembered child state (`drafting`, `ready`, `in_progress`, etc.) instead of resetting to `planned`

Because the history node is **shallow**, it restores only the last direct child of `pre_pr`, which is exactly what this phase needs.

## Why runs are separate entities

The work-item chart does **not** embed the full run lifecycle.

Instead:

- runs remain separate entities with their own statuses (`queued`, `running`, `completed`, `error`, ...)
- the work-item state machine consumes only the run outcomes that matter at the work-item level
- those outcomes enter the chart as `run.*` events (`run.pr_opened`, `run.retry_ready`, `run.errored`, etc.)

This keeps concerns separated:

- the run machine describes one execution attempt
- the work-item machine describes the durable lifecycle of the underlying unit of work

That boundary is important for later phases because multiple runs may exist for one work item while the work item still has exactly one canonical lifecycle state.

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
