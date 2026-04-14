# Escapement Studio — project conventions

This file is the home for project-level conventions that should be
applied when working in this repo. It's auto-loaded by Claude Code
when run from the repo root.

## Service size convention

- Services stay under ~400 lines where practical.
- When a service crosses ~600 lines, open an issue to extract a
  sub-service on the next feature that would grow it further.
- God classes (>1000 lines) are a code smell, not a design goal.
- Controllers should be thin. Orchestrator classes that coordinate
  sub-services are fine; service classes that own multiple unrelated
  responsibilities are not.
- When in doubt, pick "extract now" over "extract later" — the cost
  of a premature extraction is smaller than the cost of a deferred
  one.

The motivating historical context for these thresholds is
[`docs/proposals/assessment.md` §3](docs/proposals/assessment.md),
where `ExecutionService` had grown to 3286 lines before the Phase 4
extraction pass broke it apart into `RunStore`, `PullRequestService`,
`RunDispositionService`, `RunInteractionService`, `ScratchpadService`,
and `WorktreeService`. Write this convention in front of the next
class so the decision to extract gets made early instead of after.
