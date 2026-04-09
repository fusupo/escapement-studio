# Plan and run lifecycle

Detailed contract for ADR 014 (plan/run separation and expanded work item state machine).

## V1 scope

V1 applies only to **issue-backed** executable work items. Non-issue-backed items (phases, tracks, capabilities without issues) do not get plan dirs yet. The plan/run split is deliberately scoped small so the model can be validated before being generalized.

## Entities

Three entities, with clearly different lifetimes and ownership.

### Work item

- canonical graph node
- stable id (e.g. `studio-1234`)
- holds lifecycle state
- holds graph-level metadata (`predicted_files`, `actual_files`, `repo`, `issue_url`, etc.)
- one per logical unit of work

### Plan

- per work item
- stable across multiple execution attempts
- canonical scratchpad lives here
- exists before any worktree
- has its own small lifecycle (`drafting` / `ready` / `superseded`)
- referenced by zero or more runs

### Run

- per execution attempt
- ephemeral, unique id
- has a worktree
- has a session
- has events / status / outputs
- references its plan and its work item

## Filesystem layout

```text
<context-root>/
  plans/
    studio_1234/
      SCRATCHPAD_studio_1234.md
      metadata.json
  runs/
    exec_<unique>/
      metadata.json
      status.json
      events.jsonl
      summary.md
      outputs/
  worktrees/
    studio-1234-branch/
      ...
  archives/
    studio_1234/
      ...                       # populated on disposition (done or cancelled)
```

### Naming

- **work item slug**: any non-alphanumeric character is replaced with `_`, runs of `_` are collapsed, and leading/trailing `_` are trimmed
  - `studio-1234` → `studio_1234`
- **plan dir**: `plans/<slug>/`
- **canonical scratchpad**: `SCRATCHPAD_<slug>.md`
- **run id**: unique, system-generated (e.g. `exec_<timestamp>` or random)
- **run dir**: `runs/<run_id>/`

Collisions between slugs are detected at plan creation time and refused with a clear error.

### Stable vs unique identifiers

| Concept | Identifier | Stability |
|---|---|---|
| Work item | `studio-1234` | stable |
| Plan dir slug | `studio_1234` | stable |
| Run id | `exec_1775629090122` | unique per attempt |

The plan path is always derivable from the work item id.
The run id never embeds the work item id; runs reference their plan by `plan_id`.

### Where the scratchpad lives

The canonical scratchpad lives in `plans/<slug>/SCRATCHPAD_<slug>.md`.

During execution it is copied into the worktree at launch and synced back to the canonical location at phase boundaries. The plan dir is the source of truth across runs.

## Work item state machine

### States

- `planned` — issue exists, no plan yet
- `drafting` — plan is being prepared
- `ready` — plan approved, dispatchable
- `in_progress` — execution actively running
- `open_pr` — PR opened, not yet merged
- `merged_pr` — PR merged, not yet reconciled / archived
- `done` — fully closed out
- `deferred`
- `cancelled`

`blocked` and `frontier` are intentionally not states. They remain derived views computed by the dispatch planner.

### Transition table

| From | To | Trigger | Owner |
|---|---|---|---|
| `planned` | `drafting` | Prepare plan started | Planner / user action |
| `drafting` | `ready` | Plan approved | Human reviewer |
| `drafting` | `planned` | Plan discarded | Human reviewer |
| `ready` | `in_progress` | Execution launched | Execution service |
| `ready` | `drafting` | Plan reopened for edits | Human reviewer |
| `in_progress` | `open_pr` | PR created from run | Execution service |
| `in_progress` | `ready` | Run failed/abandoned, plan still valid | Execution service |
| `in_progress` | `drafting` | Run failed and plan needs rework | Human reviewer |
| `open_pr` | `merged_pr` | Merge detected | Sync flow / external |
| `merged_pr` | `done` | User action: "Close" or "Archive and close" | Disposition flow (#83 epic) |
| any active | `deferred` | Explicit defer | Human reviewer |
| any active | `cancelled` | Explicit cancel | Human reviewer |

### Why these splits matter

Each transition has a single clear actor:

- preparation is its own activity
- approval is an explicit human gate
- launching is a system action that requires `ready`
- merge is recognized as a real lifecycle phase
- archive/closeout is its own decision, not entangled with merge

### Relaunch semantics

Every execution launch goes through `ready → in_progress`. There is no direct relaunch from `in_progress`.

- If a run fails or is abandoned and the plan is still valid, the work item returns to `ready`. Relaunch then creates a new run and moves `ready → in_progress` again.
- If a run fails in a way that invalidates the plan, the work item returns to `drafting` so the plan can be revised before another launch.
- Every run has a clean `ready → in_progress → (completed | error)` arc.

### Close vs Archive and close

`merged_pr → done` is always user-driven via one of two explicit actions from the disposition flow (#83 epic):

- **Close** — transitions `merged_pr → done` without creating an archive
- **Archive and close** — creates an archive under `archives/<slug>/`, then transitions `merged_pr → done`

Both actions perform the state transition. The only difference is whether an archive is created as part of the action.

## Plan sub-state

A plan has its own small status, **tracked only on the plan**. It is not mirrored to the work item, it does not replace the work item state, and it never affects dispatch decisions on its own. It only reflects the plan's own drafting/approval lifecycle.

- `drafting`
- `ready`
- `superseded`

A plan moves to `superseded` when:

- the work item is replanned with a fresh draft
- the work item is `done` and its plan dir is archived
- the work item is `cancelled` and its plan dir is archived

### Plan metadata

Each plan dir includes a small `metadata.json` alongside the scratchpad:

```json
{
  "plan_id": "studio_1234",
  "work_item_id": "studio-1234",
  "state": "ready",
  "created_at": "...",
  "updated_at": "...",
  "approved_at": "...",
  "approved_by": "local",
  "scratchpad_path": "SCRATCHPAD_studio_1234.md",
  "run_ids": ["exec_..."]
}
```

Plan metadata is secondary to the graph. Work item state is canonical; plan metadata describes the plan only and never mirrors the work item lifecycle.

## Run lifecycle

Run status keeps its existing machine:

- `queued`
- `preparing`
- `running`
- `disambiguating`
- `completed`
- `error`
- `blocked`

Each run records:

- `run_id`
- `plan_id`
- `work_item_id`
- `worktree_path`
- `artifact_dir`
- `started_at` / `completed_at`

Multiple runs may exist per plan. The latest active run, if any, is the "current run" for the work item.

## Scratchpad lifecycle

Single canonical scratchpad per plan. No more initial/final duality at the canonical level.

### During drafting
- created/updated in `plans/<slug>/SCRATCHPAD_<slug>.md`
- planner / agent fills in summary, acceptance criteria, implementation plan, affected files, questions

### On approval
- plan state moves to `ready`
- scratchpad is the executable contract
- `predicted_files` is auto-refined from the plan's `Affected Files`

### During execution
- copied into the worktree at run start
- updated by the execution agent during the do-work phase
- synced back to `plans/<slug>/SCRATCHPAD_<slug>.md` at phase boundaries and on completion

### After execution
- canonical scratchpad continues to live in `plans/<slug>/`
- subsequent runs read from the same file
- on archival (`merged_pr → done`), the plan dir may be moved into `archives/<slug>/`

### Snapshots
Snapshots in run artifacts (e.g. `runs/<run_id>/scratchpad-at-start.md`) are **secondary** and optional. They are debugging/forensic aids, not sources of truth.

## Plan dir disposition

When the work item reaches a terminal or paused state, the plan dir is handled accordingly:

| Work item state | Plan dir disposition |
|---|---|
| `done` via "Archive and close" | Moved to `archives/<slug>/` alongside archived run artifacts |
| `done` via "Close" | Moved to `archives/<slug>/` with a disposition marker; no run artifacts archived |
| `cancelled` | Moved to `archives/<slug>/` with a disposition marker indicating cancelled |
| `deferred` | Stays in `plans/<slug>/` with plan state `superseded`; may be rehydrated later |

Plan dir moves are only allowed when no run is `in_progress` for the same work item. Moves are refused if an active run exists.

## File ownership

File-ownership directives are informed by the plan, not just the initial graph node.

### Two-tier model

- **Initial scope** — derived from `predicted_files` on the graph node, used for early dispatch readiness
- **Refined scope** — derived from the approved plan's `Affected Files` / implementation tasks, used for actual ownership during execution

At plan approval time, `predicted_files` is auto-refined from the plan's `Affected Files`. The refinement diff is shown in the approval review so the reviewer sees and accepts both the plan content and the ownership change in a single action. Dispatch ownership is recomputed after approval.

## Commit safety

The prior `.gitignore` shortcut for preventing scratchpad commits is replaced with explicit guards:

- prompt rule: never stage `SCRATCHPAD_*.md`
- hard validation in auto-commit: reject if any `SCRATCHPAD_*.md` is staged
- hard validation in PR creation: reject if any `SCRATCHPAD_*.md` is staged

This preserves agent-obedience signal while still protecting the repo.

## API surface (preview)

Illustrative only. Concrete endpoint shapes are defined at implementation time.

### Plan
- `POST /api/plans/:work_item_id/prepare` — start drafting
- `POST /api/plans/:work_item_id/approve` — drafting → ready
- `POST /api/plans/:work_item_id/reopen` — ready → drafting
- `GET  /api/plans/:work_item_id` — return plan + scratchpad

### Execution
- `POST /api/execution/launch` — must reference a `ready` plan
- existing run/cleanup/PR/sync endpoints unchanged at the surface

### Disposition
- existing #83 epic flows plug in at `open_pr → merged_pr → done`

## UI implications (minimal)

Smallest useful additions:

- on a work item / dispatch candidate, expose plan actions:
  - Prepare plan
  - Review plan
  - Launch
- show plan status alongside work item state
- runs panel continues to show ephemeral runs
- archive UI is deferred to the #83 epic

## Implementation steps

Ordered low-risk to higher-risk.

### Step 1 — Filesystem split
- introduce `plans/<slug>/` directory convention
- introduce stable slug derivation (`studio-1234 → studio_1234`)
- keep `runs/<run_id>/` semantics, but stop using run dirs as the home for scratchpads

### Step 2 — Canonical scratchpad
- canonical name `SCRATCHPAD_<slug>.md`
- canonical location `plans/<slug>/SCRATCHPAD_<slug>.md`
- demote `scratchpad-initial.md` / `scratchpad-final.md` to optional snapshots
- update prompts to reference the canonical name

### Step 3 — Expand state machine
- add `drafting`, `ready`, `merged_pr`
- update DB constraints, types, planner/legend, graph colors
- wire transitions in services

### Step 4 — Extract prepare-plan from execution launch
- new operation that drafts/updates the canonical scratchpad without creating a worktree
- moves work item: `planned → drafting → ready`
- refines `predicted_files` from the approved plan

### Step 5 — Execution reads from plan
- launch requires `ready`
- copies canonical scratchpad into worktree
- syncs back at phase boundaries
- updates work item state through `in_progress`

### Step 6 — Commit safety hardening
- drop `.gitignore` trick
- enforce staged-file validation in auto-commit and PR creation

### Step 7 — Merge / archive transitions
- `open_pr → merged_pr` on detected merge
- `merged_pr → done` on archive/closeout completion
- integration point for the #83 epic

### Step 8 — Minimal UI exposure
- Prepare plan / Review plan / Launch actions
- plan status display

## Out of scope

- planner-side scratchpad editor UI
- structured non-markdown scratchpad format
- per-plan permissioning / multi-user approval
- archive UI surface (handled by #83 epic)
- repository-discovered issue templates
- plan templating beyond the canonical Studio issue templates
- plans for non-issue-backed work items

## Notes

- This contract is compatible with the canonical Studio issue templates in `.github/ISSUE_TEMPLATE/`. The drafting step uses those templates as drafting guidance for the scratchpad.
- This contract does not require changes to the `escapement` core planner package; the new states and transitions are owned by Studio.
- See ADR 014 for the decision record.
