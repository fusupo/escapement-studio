# ADR 011: Sub-agent response contracts

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Sub-agents return structured responses rather than loose prose.

Shared response envelope:

- `run_id`
- `agent_type`
- `status`
- `summary`
- `confidence`
- `findings`
- optional `open_questions`
- optional `errors`

Findings should prioritize file references, line ranges, concise evidence summaries, and bounded snippets.

V1 specialist agents:

- code crawler
- scope predictor
- reconciliation analyst

## Rationale

- makes specialist outputs easier to trust, compare, and render
- improves root planner grounding
- avoids dumping large unstructured reports into planning context

## Consequences

- specialist tool boundaries should prefer structured JSON outputs
- browser rendering can standardize around the shared envelope while still recognizing agent-specific finding kinds
