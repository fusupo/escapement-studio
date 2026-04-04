# ADR 012: GitHub sync contract

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Studio graph is canonical for planning structure. GitHub issues are the canonical execution-facing substrate for issue-backed work items. Git is the canonical implementation substrate.

Studio enriches and orchestrates GitHub and git rather than replacing them.

V1 GitHub sync remains approval-gated, narrow, and non-destructive. Only GitHub-backed work items participate in issue sync. Updates should focus on a machine-managed planning block in issue bodies plus limited explicit fields where appropriate.

## Rationale

- preserves the richer internal graph without flattening it into GitHub
- respects issues and git as the working substrate through which execution gains traction
- keeps external side effects safe and legible

## Consequences

- non-issue graph items remain Studio-local by default
- Studio must not overwrite arbitrary human-written issue content outside managed regions
- V1 should avoid destructive automation like auto-closing issues by default
