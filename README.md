# Escapement Studio

## Development

Requires Node.js 22.19 or newer.

### Install

```bash
npm install
```

### Run server

```bash
npm run start
```

Default server URL: `http://localhost:3000`

This repo also supports a local `.env` override. For example, setting `PORT=5000` avoids conflicts with other services already using `3000`.

### Run the graph frontend

```bash
npm run dev:web
```

Default frontend URL: `http://localhost:5173`

If the API is running on a non-default port, point Vite at it with:

```bash
STUDIO_API_URL=http://localhost:3100 npm run dev:web
```

Vite will also read `STUDIO_API_URL` from a local `.env` file.

### Configure manifest path

By default, the server uses `.manifest/`. Override with:

```bash
MANIFEST_PATH=/path/to/manifest npm run start
```

### Configure root planner session storage

By default, the server stores the dedicated root planner session under `.studio/planning/sessions/`. Override with:

```bash
PLANNING_SESSION_DIR=/path/to/planning-sessions npm run start
```

### Configure run artifact storage

By default, specialist/execution run artifacts are written under the external context root `/home/marc/escapement-studio-ctx/runs/`. Override with:

```bash
ARTIFACT_ROOT=/path/to/context-root npm run start
```

### Build checks

```bash
npm run build
```

This runs the server TypeScript check plus the production frontend build.

## Graph workspace + planner chat manual verification

1. Start the API server:

   ```bash
   npm run start
   ```

2. In another terminal, start the frontend:

   ```bash
   npm run dev:web
   ```

3. Open the Vite URL shown in the terminal.
4. Confirm the header shows `API healthy`.
5. In the planner chat panel, confirm the transcript loads from `GET /api/agent/session`.
6. Send a planner message from the browser and confirm it posts to `POST /api/agent/message`.
7. Confirm assistant output streams into the chat panel in real time via `GET /api/agent/stream`.
8. Ask the planner to use a tool (for example, bash `pwd`) and confirm tool activity appears in the tool activity panel.
9. Ask the planner to propose graph mutations and confirm a reviewable mutation proposal appears in the browser.
10. Approve a subset of the proposed mutations and confirm the commit succeeds.
11. Confirm the graph refreshes and the D3 view reflects the approved changes.
12. Ask the planner to propose a planning memory update and confirm a staged memory change appears in the browser.
13. Approve the staged memory change and confirm `PLANNING_MEMORY.md` updates only after approval.
14. Ask the planner to delegate a `code-crawler` or `scope-predictor` specialist and confirm a visible specialist run appears in the browser.
15. Confirm the specialist run finishes with a structured summary/findings payload and an artifact directory under `/home/marc/escapement-studio-ctx/runs/`.
16. Select an issue-backed work item and confirm the sidebar loads GitHub issue details plus the issue link.
17. Ask the planner to use `github_read` and confirm issue details appear in the transcript/tool output.
18. Ask the planner to stage a `github_sync` proposal and confirm a reviewable GitHub sync card appears in the browser.
19. Approve the staged GitHub sync and confirm only the managed `studio-sync` issue body block changes.
20. Review the execution dispatch panel and confirm it loads a dispatch preview from `GET /api/execution/preview`.
21. Confirm each dispatchable node shows worktree/branch safety checks before launch.
22. In the planning graph, select an eligible issue-backed node and confirm the details sidebar Execution card clearly identifies the selected node and shows an enabled **Launch execution** action.
23. Select a blocked issue-backed node and confirm the same Execution card keeps the selected-node context visible while showing the backend-provided launch-unavailable reason.
24. Select a non-issue node (for example a track, phase, or capability) and confirm the Execution card explains that launch is only available for issue-backed work items and does not show the **Launch execution** button.
25. Launch a dispatchable execution run from the details sidebar and confirm status updates stream into the browser from `GET /api/execution/stream` and the app switches into the Execute tab.
26. Confirm the launched run creates an isolated worktree under the configured repo artifact root (for example `/home/marc/escapement-studio-ctx/worktrees/`) and artifacts under the matching repo artifact root `runs/` directory.
27. Trigger a blocked launch condition (for example, reuse an existing branch/worktree) and confirm the browser shows a blocked execution run with clear safety errors.
28. Confirm the completed execution run auto-populates the related work item `actual_files` from the recorded `changed_files`.
29. Restart the Studio server after a completed execution run and confirm the Execute tab still shows the recent run, including `result_summary`, changed files, PR metadata, chat history, and canonical scratchpad content.
30. Restart the Studio server while an execution run is still active and confirm the run is rehydrated as `error` with an explicit orphan/restart note instead of disappearing.
31. If the worktree still exists, open the run checklist after restart and confirm it is reconstructed from the worktree scratchpad.
32. Open the reconciliation panel and confirm `GET /api/reconciliation/reports` shows matches, missed predicted files, unpredicted actual files, and drift summaries for reconciled work items.
33. Ask the planner to delegate a `reconciliation-analyst` or call `reconciliation_query`, then stage a planning-memory update based on the reported drift and approve it through the existing memory approval flow.
34. Ask the planner to revise or reject the current graph, memory, or GitHub sync proposal from the browser and confirm the follow-up stays in the same planner conversation.
35. Refresh the page and confirm recent transcript state plus the latest active proposal/memory change/GitHub sync results, recent specialist runs, recent execution runs, and reconciliation reports are restored.
36. Verify the graph view still loads data from `/api/graph`.
37. Select a node to edit it in the sidebar.
38. Expand the collapsed **Create work item** section, create a new work item from the sidebar, and confirm it appears in the graph.
39. Expand the collapsed **Edges** section, create an edge between two nodes, and confirm it appears in the graph and edge list.
40. Collapse and re-expand the **Edges** section, then delete an edge from the sidebar.
41. Change repo/state/track/phase filters and confirm the rendered graph updates.

## API smoke checks

### Health

```bash
curl http://localhost:3000/health
```

### List work items

```bash
curl http://localhost:3000/api/work-items
```

### Create a work item

```bash
curl -X POST http://localhost:3000/api/work-items \
  -H 'content-type: application/json' \
  -d '{
    "id": "studio-1",
    "name": "Server scaffold",
    "kind": "issue",
    "state": "planned",
    "repo": "fusupo/escapement-studio"
  }'
```

### Update a work item

```bash
curl -X PUT http://localhost:3000/api/work-items/studio-1 \
  -H 'content-type: application/json' \
  -d '{"scope_hint": "Initial backend setup"}'
```

### Create an edge

```bash
curl -X POST http://localhost:3000/api/edges \
  -H 'content-type: application/json' \
  -d '{
    "from_id": "studio-1",
    "rel": "is_part_of",
    "to_id": "track:foundation"
  }'
```

### Query graph/frontier/plan

```bash
curl http://localhost:3000/api/graph
curl http://localhost:3000/api/graph?state=planned
curl http://localhost:3000/api/frontier
curl http://localhost:3000/api/plan
```

`GET /api/graph` also returns `graph_version` for stale-write detection.

### Apply an atomic graph mutation batch

```bash
curl -X POST http://localhost:3000/api/graph/mutations \
  -H 'content-type: application/json' \
  -d '{
    "proposal_id": "prop-1",
    "based_on_graph_version": "0",
    "mutations": [
      {
        "mutation_id": "m1",
        "kind": "create_work_item",
        "work_item": {
          "id": "studio-track",
          "name": "Studio Track",
          "kind": "track"
        }
      },
      {
        "mutation_id": "m2",
        "kind": "create_work_item",
        "work_item": {
          "id": "studio-1",
          "name": "Server scaffold",
          "kind": "issue"
        }
      },
      {
        "mutation_id": "m3",
        "kind": "create_edge",
        "edge": {
          "from_id": "studio-1",
          "rel": "is_part_of",
          "to_id": "studio-track"
        }
      }
    ]
  }'
```

The server validates the full batch, applies it transactionally, and returns either `applied`, `validation_failed`, or `stale`.

### Root planner session snapshot

```bash
curl http://localhost:3000/api/agent/session
```

The snapshot returns the recent planner transcript plus active proposal/memory/GitHub-sync state and recent specialist runs used by the browser to restore workspace state after refresh.
Execution runs are restored separately from `GET /api/execution/runs`.
Reconciliation reports are restored from `GET /api/reconciliation/reports`.

### Root planner message + stream

Open the SSE stream in one terminal:

```bash
curl -N http://localhost:3000/api/agent/stream
```

Then send a planner message in another terminal:

```bash
curl -X POST http://localhost:3000/api/agent/message \
  -H 'content-type: application/json' \
  -d '{"message":"Reply with exactly: ok"}'
```

You can also request a specific graph context mode for the turn:

```bash
curl -X POST http://localhost:3000/api/agent/message \
  -H 'content-type: application/json' \
  -d '{
    "message":"Inspect the current planning graph",
    "context": {
      "graph_mode": "focused",
      "repo": "fusupo/escapement-studio",
      "track": "track:foundation"
    }
  }'
```

`graph_mode` supports `default`, `focused`, and `full`.
The assembled planner context includes:
- truncated `STUDIO_OVERVIEW.md`
- truncated `STUDIO_ARCHITECTURE.md`
- `PLANNING_MEMORY.md`
- graph triples for the selected slice
- a small recent conversation window

The stream should emit SDK-native event names like `agent_start`, `turn_start`, `message_update`, and `agent_end` inside the Studio SSE envelope.
It also emits Studio workflow events: `mutation_proposal`, `graph_commit_result`, `memory_change_proposal`, `memory_write_result`, `github_sync_proposal`, `github_sync_result`, `subagent_status`, and `subagent_result`.

Execution runs use a separate SSE channel:

```bash
curl -N http://localhost:3000/api/execution/stream
```

That stream emits `execution_status` and `execution_result` envelopes as runs move through safety checks, worktree preparation, active execution, and terminal states.

### Preview execution dispatch

```bash
curl http://localhost:3000/api/execution/preview
curl http://localhost:3000/api/execution/runs
```

The preview returns dispatchable frontier groups, per-node safety checks, and launch metadata such as the target branch and isolated worktree path.

### Launch an execution run

```bash
curl -X POST http://localhost:3000/api/execution/launch \
  -H 'content-type: application/json' \
  -d '{
    "work_item_id": "studio-10"
  }'
```

A successful launch returns an accepted execution run record and starts work in an isolated git worktree under the configured repo artifact root:

```text
<artifact-root>/worktrees/<branch>/
```

Execution artifacts are persisted under:

```text
<artifact-root>/runs/<run_id>/
  metadata.json
  status.json
  events.jsonl
  summary.md
  outputs/
```

`status.json` is the restart-recovery source of truth for execution runs. On boot, Studio reloads recent runs from these snapshots, rewrites previously non-terminal runs (`queued`, `preparing`, `disambiguating`, `running`) to `error` with an orphan note, and keeps completed-run fields such as `result_summary`, `changed_files`, `pull_request`, and durable `activity_log` chat history available to the Execute tab.

Studio's repo discovery model treats a local checkout as the primary repo identity. GitHub `owner/repo` should be derived from `git remote get-url origin`, and a suggested artifact root can be read from `**context-path**` in `AGENTS.md` or `CLAUDE.md`.

Blocked launches return `accepted: false` plus a run record with `status: "blocked"` and explicit safety check failures.

### Read reconciliation reports

```bash
curl http://localhost:3000/api/reconciliation/reports
curl http://localhost:3000/api/reconciliation/reports?work_item_id=studio-10
```

Each report compares `predicted_files` to the work item's recorded `actual_files`, links back to recent completed execution runs when available, and summarizes drift/overlap patterns that can be fed back into planning memory.

### Read a GitHub issue linked to a work item

```bash
curl "http://localhost:3000/api/github/issue?repo=fusupo/escapement-studio&issue_number=10"
```

This returns issue details plus the current managed `studio-sync` block, if present.

### Delegate a specialist sub-agent

Ask the planner to run a specialist, or directly ask it to call `delegate_subagent`:

```bash
curl -X POST http://localhost:3000/api/agent/message \
  -H 'content-type: application/json' \
  -d '{
    "message":"Use delegate_subagent with agent_type `code-crawler` to inspect likely files for the planning service browser workflow"
  }'
```

Then inspect recent specialist runs in the session snapshot:

```bash
curl http://localhost:3000/api/agent/session
```

Each completed run should also persist artifacts under:

```text
<artifact-root>/runs/<run_id>/
  metadata.json
  status.json
  events.jsonl
  summary.md
  outputs/
```

For the full execution/artifact contract, including restart recovery and archive edge cases, see [`docs/contracts/run-artifacts.md`](docs/contracts/run-artifacts.md).

### Stage and approve a GitHub sync

First ensure the target issue body already contains a managed block bounded by:

```md
<!-- studio-sync:start -->
...
<!-- studio-sync:end -->
```

Then ask the planner to stage a GitHub sync for an issue-backed work item:

```bash
curl -X POST http://localhost:3000/api/agent/message \
  -H 'content-type: application/json' \
  -d '{
    "message":"Use github_sync for work_item_id `studio-10` and stage a managed-block sync proposal"
  }'
```

Inspect the staged GitHub sync proposal in the planner session snapshot:

```bash
curl http://localhost:3000/api/agent/session
```

Approve selected GitHub sync operations:

```bash
curl -X POST http://localhost:3000/api/agent/github/approve \
  -H 'content-type: application/json' \
  -d '{
    "sync_id": "ghsync_123",
    "approved_operation_ids": ["op1"]
  }'
```

The result returns `applied`, `validation_failed`, or `stale`. If the issue body changed since staging, the sync is rejected as stale. If the managed block is missing or ambiguous, sync fails safely.

### Stage and approve a planning memory change

First, ask the planner to read memory and stage a targeted change:

```bash
curl -X POST http://localhost:3000/api/agent/message \
  -H 'content-type: application/json' \
  -d '{
    "message":"Use memory_read and then memory_write to stage one targeted planning memory edit"
  }'
```

Then inspect the staged change and current memory hash:

```bash
curl http://localhost:3000/api/agent/session
```

Approve a subset of staged memory edit IDs:

```bash
curl -X POST http://localhost:3000/api/agent/memory/approve \
  -H 'content-type: application/json' \
  -d '{
    "change_id": "mem_123",
    "approved_edit_ids": ["e1"]
  }'
```

The write result returns `applied`, `validation_failed`, or `stale`, plus the latest `PLANNING_MEMORY.md` content/hash and any remaining active staged memory change.

### Approve a structured mutation proposal

### Approve a structured mutation proposal

First, ask the planner to stage a proposal:

```bash
curl -X POST http://localhost:3000/api/agent/message \
  -H 'content-type: application/json' \
  -d '{
    "message":"Use propose_mutations to stage one demo create_work_item proposal and then reply with exactly: proposal-ready"
  }'
```

Then inspect the active proposal:

```bash
curl http://localhost:3000/api/agent/session
```

Approve a subset of mutation IDs from that proposal:

```bash
curl -X POST http://localhost:3000/api/agent/proposals/approve \
  -H 'content-type: application/json' \
  -d '{
    "proposal_id": "prop_123",
    "approved_mutation_ids": ["m1"]
  }'
```

The approval result returns the graph writer status (`applied`, `validation_failed`, or `stale`) plus any remaining active proposal state for the browser.

### Delete test data

```bash
curl -X DELETE http://localhost:3000/api/edges/1
curl -X DELETE http://localhost:3000/api/work-items/studio-1
```
