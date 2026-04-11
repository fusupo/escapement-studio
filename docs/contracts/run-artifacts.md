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

## Follow-up chat

Active and recently completed execution runs support follow-up messages from the Studio UI.

### Delivery modes

| Run status | Delivery | Behavior |
|------------|----------|----------|
| `running` / `preparing` | `steer` | Interrupts the current turn; message is delivered before the next LLM call. |
| `running` / `preparing` | `followUp` (default) | Queued; delivered when the current turn finishes. |
| `completed` | `new_turn` | A new agent session is created in the same worktree and the follow-up is sent as a fresh prompt. |

### API

- `POST /api/execution/follow-up` — `{ run_id, message, delivery? }`
- `GET /api/execution/runs/:runId/chat` — returns chat history `{ run_id, messages: [{ timestamp, role, text }] }`

### Artifact events

Follow-up interactions append to the existing `events.jsonl`:

- `follow_up_sent` — when a steer/followUp message is accepted by an active session
- `follow_up_turn_completed` — when a new-turn follow-up finishes

## Archive bundle layout

Issue #86 introduces the run-archive bundle produced by
`archiveRunArtifactsForWorkItem` (see `src/modules/execution/run-archiver.ts`).
The bundle is a single directory under the context root that preserves
every terminal execution run for a completed work item, together with
the canonical plan dir (when it has already been archived by
`archiveAndCloseMergedPullRequest`) and a human-readable `README.md`.

### Directory tree

```text
<context-root>/archives/<slug>/
  README.md                       # generated summary (issue #86)
  metadata.json                   # plan metadata, preserved from plans/<slug>/ (optional)
  SCRATCHPAD_<slug>.md            # canonical scratchpad, preserved from plans/<slug>/ (optional)
  runs/
    <run_id>/                     # moved verbatim from runs/<run_id>/
      status.json
      events.jsonl
      summary.md
      outputs/
        response.json
        pull-request.json
```

`<slug>` is the work item slug derived by `workItemSlug(workItemId)` —
the same helper used for `plans/<slug>/` and `archives/<slug>/` elsewhere
(see `src/lib/context-layout.ts`).

### Move semantics

- **Runs:** each `runs/<run_id>/` is moved into
  `archives/<slug>/runs/<run_id>/` via `fs.renameSync`. Mirrors the plan
  dir archival path used by `movePlanDirToArchives` (ADR 014 step 7).
- **Plan dir artifacts:** `README.md` cross-links any
  `SCRATCHPAD_<slug>.md` / `metadata.json` / other files already present
  in `archives/<slug>/` when the archiver runs. In the common path #88
  will call `archiveAndCloseMergedPullRequest` first, so those files
  will exist before the run archiver starts.
- **Atomicity:** archival is NOT transactional. Earlier moves are not
  rolled back if a later move hits a collision — the archiver fails fast
  and operators must resolve the partial state manually (see the
  `archive_already_exists_run` error below).

### Guards and errors

- **Active-run guard:** runs in `queued`, `preparing`, `disambiguating`,
  or `running` cause the archiver to raise `archive_run_active` BEFORE
  any filesystem mutation. The wrapper
  (`ExecutionService.archiveRunArtifacts`) additionally uses
  `assertNoActiveRunForWorkItem` so the HTTP surface sees a
  `BadRequestException` with a `cannot_dispose_work_item_active_run`
  message identical to the other disposition guards.
- **Destination collisions:** if `archives/<slug>/runs/<run_id>/`
  already exists, the archiver raises `archive_already_exists_run` with
  the conflicting path. `archives/<slug>/README.md` is always
  overwritten — it is a pure function of the work item + archived runs
  so regenerating it is safe.
- **Missing source:** if a terminal run record references a missing
  `runs/<run_id>/` source dir (e.g. operator deleted it manually), the
  archiver logs a warning and records
  `{ run_id, reason: "source_missing" }` in `skipped_run_ids` instead of
  raising.

### `README.md` fields

The generated `README.md` is plain Markdown with the following sections,
in order:

| Section | Contents |
|---------|----------|
| Title | `# Archive: <work_item_id> — <work_item_name>` |
| Work item | id, name, kind, state, repo, issue link, branch, `archived_at`, `archive_path` |
| Pull request | number, url, title, base_ref, head_ref, state, merged_at, merge_commit_sha — sourced from `work_item.meta.studio_post_merge_sync.pull_request` (omitted when absent) |
| Archived runs | per-run block: run_id, status, branch, base_ref, timestamps, changed-file count, optional pull_request link, archive path under `runs/<run_id>/`, truncated `result_summary` |
| Skipped runs | optional — run_id + reason for any run not moved (`not_terminal:<status>` or `source_missing`) |
| Plan artifacts | optional cross-links to `SCRATCHPAD_<slug>.md` and `metadata.json` when plan-dir archival ran first |
| Notes | Move-semantics reminder and links to ADR 014 + this contract document |

### Wiring (as of issue #86)

`ExecutionService.archiveRunArtifacts(workItemId)` is the Nest-level
entry point. It is NOT yet invoked by
`archiveAndCloseMergedPullRequest` — that wiring lands in issue #88 as
part of the `Archive and close` disposition flow. Until then the
helper is directly callable from tests and can be wired into future
operator tooling, but the end-user “Archive and close” button still
only archives the plan dir.

See:
- [ADR 014: plans/runs state model](../adr/014-plans-runs-state-model.md) (step 7: `merged_pr → done` disposition)
- [Issue #83](https://github.com/fusupo/escapement-studio/issues/83) — merged execution-run disposition epic
- [Issue #88](https://github.com/fusupo/escapement-studio/issues/88) — disposition wiring that will call this helper

## Notes

- `status.json` and SSE serve different purposes: current durable snapshot vs live browser transport
- artifacts should be retained by default in V1
- failed runs should still write terminal status, terminal event, and best-effort summary
- when a PR is opened from a completed execution run, the run summary/status may also include the created PR URL for later browser refreshes
