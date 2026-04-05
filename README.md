# Escapement Studio

## Development

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
12. Ask the planner to revise or reject the current proposal from the browser and confirm the follow-up stays in the same planner conversation.
13. Refresh the page and confirm recent transcript state plus the latest active proposal/commit result are restored.
14. Verify the graph view still loads data from `/api/graph`.
15. Select a node to edit it in the sidebar.
16. Create a new work item in the sidebar and confirm it appears in the graph.
17. Create an edge between two nodes and confirm it appears in the graph and edge list.
18. Delete an edge from the sidebar.
19. Change repo/state/track/phase filters and confirm the rendered graph updates.

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

The snapshot returns the recent planner transcript used by the browser to restore chat state after refresh.

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
It also emits Studio mutation workflow events: `mutation_proposal` and `graph_commit_result`.

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
