# GitHub sync contract

## Purpose

Define how Studio synchronizes issue-backed planning state to GitHub while preserving the graph as the richer planning structure.

## Core model

- **Studio graph** — canonical planning structure and decomposition
- **GitHub issues** — canonical execution-facing substrate for issue-backed work items
- **Git state** — canonical implementation substrate

Studio enriches and orchestrates GitHub and git rather than replacing them.

## V1 rules

- sync is one-way from Studio to GitHub
- sync is approval-gated
- sync is narrow and non-destructive
- only GitHub-backed work items participate in issue sync
- non-issue graph items remain Studio-local by default

## Recommended write scope

Focus V1 writes on:

- issue title where appropriate
- machine-managed planning block in issue body
- optional lightweight labels/state indicators if explicitly chosen

Avoid by default:

- automatic issue closure
- destructive lifecycle automation
- flattening the full graph into GitHub

## Managed block example

```md
<!-- studio-sync:start -->
## Studio Planning Metadata
- State: planned
- Scope hint: Add collection guard enforcement to gateway layer
- Predicted files:
  - `portal/src/guards/collection.guard.ts`
  - `portal/src/app.module.ts`
- Depends on:
  - sr#474
- Part of:
  - track:platform:auth
<!-- studio-sync:end -->
```

## Safety rule

Studio must not overwrite arbitrary human-authored issue content outside the managed block.

If the managed block is missing or cannot be safely updated, sync should fail safely and require review.
