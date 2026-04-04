# Mutation proposals

## Purpose

Define the structured contract the planning agent uses to propose graph changes for browser rendering and human approval.

## Envelope

```json
{
  "proposal_id": "prop_2026-04-04_001",
  "created_at": "2026-04-04T18:30:00Z",
  "source": {
    "agent": "root-planner",
    "turn_id": "turn_184",
    "session_id": "planning-root"
  },
  "context": {
    "scope": "track:platform:auth",
    "mode": "focused",
    "based_on_graph_version": "128"
  },
  "summary": "Propose 3 new work items and 2 dependency edges for auth hardening.",
  "mutations": []
}
```

## V1 mutation types

- `create_work_item`
- `update_work_item`
- `create_edge`
- `delete_edge`
- `delete_work_item`

## Mutation shape

```json
{
  "id": "m1",
  "type": "create_work_item",
  "entity_id": "sr#710",
  "payload": {
    "name": "Portal gateway collection guard",
    "kind": "issue",
    "state": "planned",
    "repo": "portal",
    "scope_hint": "Add collection guard enforcement to gateway layer.",
    "predicted_files": [
      "portal/src/guards/collection.guard.ts",
      "portal/src/app.module.ts"
    ],
    "meta": {
      "confidence": "medium"
    }
  },
  "rationale": "The gateway needs a distinct guard-level work item to isolate collection enforcement.",
  "validation": {
    "requires_absent_entity": true
  }
}
```

Optional fields:

- `group_id`
- `validation`
- `depends_on_mutation_ids`

## Required fields

Envelope:

- `proposal_id`
- `created_at`
- `source`
- `summary`
- `mutations`

Mutation:

- `id`
- `type`
- `rationale`
- `entity_id` where relevant
- `payload` where relevant

## Approval request

```json
{
  "proposal_id": "prop_2026-04-04_001",
  "approved_mutation_ids": ["m1", "m2"],
  "based_on_graph_version": "128"
}
```

## V1 notes

- browser approves selected mutation IDs, not freeform text
- proposals are tied to a graph version
- delete operations should remain more constrained than create/update operations
