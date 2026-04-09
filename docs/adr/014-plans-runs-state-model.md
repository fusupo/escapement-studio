# ADR 014: Plan/run separation and expanded work item state machine

- **Status:** accepted
- **Date:** 2026-04-09

## Decision

Separate **plans** from **runs** as distinct first-class entities in Studio:

- **Work item** — canonical graph node with lifecycle state
- **Plan** — per work item, stable across execution attempts, holds the canonical scratchpad
- **Run** — per execution attempt, ephemeral, unique id, references its plan

Expand the work item state machine so every transition has a single clear actor:

- `planned` — issue exists, no plan yet
- `drafting` — plan is being prepared
- `ready` — plan approved, dispatchable
- `in_progress` — execution actively running
- `open_pr` — PR opened, not yet merged
- `merged_pr` — PR merged, not yet archived
- `done` — fully closed out
- `deferred`
- `cancelled`

Canonical scratchpad lives at `plans/<slug>/SCRATCHPAD_<slug>.md` where `<slug>` is derived from the work item id (`studio-1234` → `studio_1234`). The context root is organized into `plans/`, `runs/`, `worktrees/`, and `archives/`.

V1 applies only to issue-backed executable work items. Non-issue work items (phases, tracks, capabilities without issues) are out of scope.

Detailed spec in `docs/contracts/plan-and-run-lifecycle.md`.

## Rationale

- file-ownership directives can be refined from an approved plan rather than only from initial graph metadata
- a single canonical scratchpad replaces three scratchpad-shaped artifacts (`SCRATCHPAD.md` in the worktree, `scratchpad-initial.md`, `scratchpad-final.md`) with unclear precedence
- every state transition has one clear actor (planner, human reviewer, execution service, disposition flow)
- multiple execution attempts can share the same plan without regenerating the scratchpad per run
- `merged_pr` gives the disposition epic (#83) a coherent attach point without overloading `done`

## Consequences

- execution launch is split into plan preparation (`planned → drafting → ready`) and execution (`ready → in_progress`)
- `predicted_files` is auto-refined from approved plans, with the diff surfaced in the approval review
- `runs/<run_id>/` stays per-attempt and ephemeral; scratchpads no longer live there as canonical
- the existing `.gitignore` approach for scratchpad commit safety is replaced by hard validation in auto-commit and PR creation
- disposition flows (#83, #84, #86, #88, #89) plug in at `open_pr → merged_pr → done` without further redesign
- supersedes the draft proposal at `docs/proposals/plans-runs-state-model.md`
