# Run artifact layout

## Purpose

Define the standard durable artifacts produced by long-running planning, specialist, execution, and reconciliation runs.

## Root layout

Artifacts live under a configurable context/artifact root, ideally outside normal committed source files or in an ignored directory.

Suggested V1 layout:

```text
<context-root>/runs/<run_id>/
  metadata.json
  status.json
  events.jsonl
  summary.md
  outputs/
```

## Required V1 files

### `metadata.json`
Stable identity and provenance.

Example fields:

- `run_id`
- `run_type`
- `created_at`
- `session_id`
- `work_item_ids`
- `branch`
- `worktree`
- `agent_type`

### `status.json`
Current mutable snapshot.

Example fields:

- `run_id`
- `status`
- `phase`
- `started_at`
- `updated_at`
- `progress_message`
- `result`

### `events.jsonl`
Append-only durable event log.

### `summary.md`
Human-readable completion summary where practical.

### `outputs/`
Optional extra outputs and attachments.

Common execution outputs may include:

- `response.json` — captured execution-agent terminal response and changed-file sync result
- `pull-request.json` — created PR metadata when Studio opens a PR from completed work

## Run types

Suggested V1 types:

- `planning`
- `subagent`
- `execution`
- `reconciliation`

## Notes

- `status.json` and SSE serve different purposes: current durable snapshot vs live browser transport
- artifacts should be retained by default in V1
- failed runs should still write terminal status, terminal event, and best-effort summary
- when a PR is opened from a completed execution run, the run summary/status may also include the created PR URL for later browser refreshes
