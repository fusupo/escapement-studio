# Sub-agent response contracts

## Purpose

Define the shared response envelope for specialist agents and the expected shape of findings.

## Shared envelope

```json
{
  "run_id": "sub_44",
  "agent_type": "code-crawler",
  "status": "completed",
  "summary": "Auth gateway enforcement likely touches 4 modules.",
  "confidence": "medium",
  "findings": [],
  "open_questions": [],
  "errors": []
}
```

## Shared fields

- `run_id`
- `agent_type`
- `status`
- `summary`
- `confidence`: `low` | `medium` | `high`
- `findings`
- optional `open_questions`
- optional `errors`

## Finding guidance

Findings should prioritize:

- relevant files
- line ranges where possible
- concise evidence summaries
- short bounded snippets only when useful
- no whole-file dumps

Example finding:

```json
{
  "kind": "file_impact",
  "file": "portal/src/guards/collection.guard.ts",
  "lines": "1-80",
  "summary": "Primary guard logic appears here.",
  "snippet": "if (!user.collections.includes(collectionId)) ..."
}
```

## V1 specialists

### Code crawler
Typical finding kinds:

- `file_impact`
- `pattern_match`
- `dependency`
- `entrypoint`
- `risk`

### Scope predictor
Typical finding kinds:

- `predicted_file`
- `predicted_module`
- `likely_dependency`
- `uncertainty`

### Reconciliation analyst
Typical finding kinds:

- `prediction_match`
- `prediction_miss`
- `overprediction`
- `drift_pattern`
- `recommendation`

## Failure shape

```json
{
  "run_id": "sub_47",
  "agent_type": "code-crawler",
  "status": "error",
  "summary": "Code crawler failed before completing dependency analysis.",
  "confidence": "low",
  "errors": [
    {
      "code": "search_failed",
      "message": "Repository search command returned non-zero status."
    }
  ],
  "findings": []
}
```
