# Graph commit semantics

## Purpose

Define how approved mutation proposals are validated and applied to the graph.

## V1 rules

- user may approve any subset of mutations from a proposal
- selected subset is applied atomically in one transaction
- full batch validation occurs before any write
- no partial success
- server normalizes mutation ordering before apply
- stale proposals are rejected based on graph version
- retries should be idempotent where practical
- `delete_work_item` is restricted to safe cases, preferably isolated nodes only

## Recommended normalized order

1. `create_work_item`
2. `update_work_item`
3. `create_edge`
4. `delete_edge`
5. `delete_work_item`

## Apply lifecycle

1. verify proposal identity and approved mutation IDs
2. verify `based_on_graph_version`
3. materialize selected mutations
4. validate entire batch
5. apply in one transaction
6. bump graph version
7. return explicit result

## Validation failures

If any selected mutation fails validation, reject the entire batch.

Example reasons:

- missing entity
- duplicate entity
- duplicate edge
- invalid relation
- unsafe delete
- malformed payload

## Result shapes

### Success

```json
{
  "status": "applied",
  "proposal_id": "prop_2026-04-04_001",
  "applied_mutation_ids": ["m1", "m2"],
  "previous_graph_version": "128",
  "new_graph_version": "129"
}
```

### Validation failure

```json
{
  "status": "validation_failed",
  "proposal_id": "prop_2026-04-04_001",
  "errors": [
    {
      "mutation_id": "m2",
      "code": "missing_entity",
      "message": "from_id sr#710 does not exist"
    }
  ]
}
```

### Stale proposal

```json
{
  "status": "stale",
  "proposal_id": "prop_2026-04-04_001",
  "previous_graph_version": "128",
  "current_graph_version": "130",
  "message": "Proposal is out of date and must be regenerated."
}
```
