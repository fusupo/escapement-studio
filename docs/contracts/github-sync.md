# GitHub sync contract

## Purpose

Define how Studio synchronizes issue-backed planning state to GitHub while preserving the graph as the richer planning structure.

## Core model

- **Studio graph** — canonical planning structure and decomposition
- **GitHub issues** — canonical execution-facing substrate for issue-backed work items
- **Git state** — canonical implementation substrate

Studio enriches and orchestrates GitHub and git rather than replacing them.

## Rules

- sync is one-way from Studio to GitHub
- sync is approval-gated
- only GitHub-backed work items participate in issue sync
- non-issue graph items remain Studio-local by default
- broader issue-body edits remain limited to the GitHub issue linked from the current `work_item_id`
- Studio stages proposals only; direct GitHub mutation outside approval is forbidden

## Supported write scope

Studio supports two approval-gated issue-body sync modes:

1. **Managed block sync**
   - operation kind: `update_managed_body_block`
   - updates only the `studio-sync` block bounded by the managed markers
   - fails closed if the block is missing, duplicated, or unsafe to replace

2. **Broader issue body replacement**
   - operation kind: `replace_issue_body`
   - stages an explicit final issue body (`body_after`) for the issue linked from `work_item_id`
   - requires review data containing full `before`, full `after`, and a unified diff of the exact body change
   - must preserve any existing managed `studio-sync` block unchanged

Avoid by default:

- automatic issue closure
- destructive lifecycle automation
- arbitrary repository / issue targeting
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

## Safety rules

### Managed block sync

Studio may update the machine-managed block only through the managed-block sync path.

If the managed block is missing or cannot be safely updated, sync should fail safely and require review.

### Broader issue body replacement

Studio may stage a broader issue body edit only when the planner supplies the complete proposed final body.

That broader edit must:
- target only the GitHub issue already linked from `work_item_id`
- preserve any existing `studio-sync` block unchanged
- be reviewable as a unified diff, with full before/after text available
- fail safely if the issue body changed after staging (`based_on_body_hash` mismatch)
