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
Current mutable snapshot and the authoritative restart-recovery record for execution runs.

Example fields:

- `run_id`
- `status`
- `phase`
- `started_at`
- `updated_at`
- `progress_message`
- `result`

For execution runs, `status.json` is expected to carry the full `ExecutionRunRecord` snapshot used by `GET /api/execution/runs` after a server restart, including:

- identity/provenance: `run_id`, `work_item_id`, `work_item_name`, `branch`, `base_ref`, `worktree_path`, `artifact_dir`
- lifecycle state: `status`, `created_at`, `updated_at`, optional `started_at` / `completed_at` / `disposed_at`
- user-visible detail fields: `progress_message`, `result_summary`, `changed_files`, `pull_request`, `errors`
- durable chat/activity state: `activity_log`
- launch safety context: `safety_checks`
- latest checklist projection: optional `checklist` (described below)

Loader behavior (`src/modules/execution/run-disk-store.ts`):

- malformed JSON or snapshots missing required fields are skipped with a warning
- snapshots with unknown execution statuses are skipped with a warning
- disposed runs (`disposed_at != null`) are excluded from the live recent-runs hydration path by default
- optional arrays/objects are sanitized so malformed entries do not poison restart recovery

#### Durable execution checklist

The latest checklist is embedded in `status.json.checklist`; there is no separate `checklist.json` artifact:

```json
{
  "run_id": "exec_123",
  "revision": 4,
  "updated_at": "2026-07-21T12:34:56.000Z",
  "items": [
    { "text": "Implement persistence", "checked": true, "category": "implementation" },
    { "text": "Progress survives restart", "checked": true, "category": "acceptance" },
    { "text": "Run npm test", "checked": false, "category": "verification" }
  ],
  "completed": 1,
  "total": 1
}
```

- Categories are `implementation`, `acceptance`, and `verification`. `Quality Checks` and `Manual Verification` both project to `verification`.
- `completed` and `total` count implementation items only. Acceptance and verification are independent evidence and are displayed separately.
- Revisions start at 1 and increase only when projected content changes. `updated_at` is the ISO time of that transition. A response with no persisted or readable source uses revision 0 and `updated_at: null`.
- Studio writes the updated `status.json` before publishing `execution_checklist` over SSE. A failed artifact write therefore cannot advertise non-durable progress.
- SSE is best-effort transport, not a replay log. Browsers converge through checklist GETs on initial load, stream reconnect, focus, and visible-tab resume. REST and SSE clients accept only a strictly newer revision for the same run.
- A readable worktree scratchpad can project and persist newer content during GET or session observation. If the worktree is missing or unreadable, the durable `status.json.checklist` remains authoritative and is never replaced by an empty projection.
- The coding agent owns the implementation completion transition: implement the task, run its relevant automated checks, mark the implementation checkbox and append the Work Log entry, then commit and continue. Acceptance and verification boxes are marked only when their evidence is actually satisfied or performed.

### `events.jsonl`
Append-only durable event log.

`events.jsonl` is useful for forensics and richer timeline reconstruction, but the Studio execution UI currently rehydrates from `status.json` first. If the two disagree after a crash, `status.json` wins for recent-run list/detail hydration and `events.jsonl` remains best-effort diagnostic history.

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

The corresponding user/assistant messages must also be reflected in `status.json.activity_log` immediately so a crash between turns does not lose chat history from `GET /api/execution/runs/:runId/chat`.

## Execution restart recovery

On Studio boot, execution restart recovery follows this order:

1. `WorkItemReconcilerService.runStartupReconcile()` scans `runs/<run_id>/status.json`.
2. Any non-terminal execution run left in `queued`, `preparing`, `disambiguating`, or `running` is rewritten in place to `status: "error"`.
3. The orphan rewrite appends an `activity_log` entry explaining that the run was orphaned by server restart and adds an `orphaned_by_restart` error.
4. `ExecutionService.hydrateRecentRunsFromDisk()` reloads the newest live snapshots into the in-memory recent-runs buffer.

This means operators can rely on the following restart semantics:

- completed/error/blocked runs remain visible in the Execute tab after restart
- runs that were active during a crash are preserved as errored runs with an explicit restart note instead of disappearing
- completed-run metadata such as `result_summary`, `changed_files`, and `pull_request` survive as long as `status.json` survives
- chat history survives when `activity_log` was flushed before the crash

### Detail endpoint sources after restart

| Endpoint | Primary source | Fallback / notes |
|---------|----------------|------------------|
| `GET /api/execution/runs` | live in-memory buffer rehydrated from `status.json` | capped to the service recent-run limit |
| `GET /api/execution/runs/:runId/chat` | `status.json.activity_log` | only `user_message` / `agent_message` entries are surfaced |
| `GET /api/execution/runs/:runId/scratchpad` | canonical `plans/<slug>/SCRATCHPAD_<slug>.md` | falls back to the surviving worktree scratchpad when canonical is absent |
| `GET /api/execution/runs/:runId/checklist` | readable worktree `SCRATCHPAD_<slug>.md`, projected into `status.json.checklist` | falls back to the durable snapshot after restart or worktree removal; revision-0 empty shape only when neither source exists |

### Archive/restart edge cases

- Archived/disposed runs are intentionally excluded from the live recent-runs list after restart; they are surfaced through the archived-runs endpoints instead.
- If only an archive bundle survives, the archived-runs readers can still expose summary/history data, but the live Execute tab should not resurrect the disposed run into `/api/execution/runs`.
- Scratchpad restoration is strongest when the canonical plan file still exists. Checklist restoration remains available from `status.json.checklist` even after worktree removal.
- Legacy runs without a persisted checklist return the revision-0 empty shape when no readable worktree survives.

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
- execution restart recovery is filesystem-backed in V1; no separate SQLite/index source of truth is required for recent-run hydration
