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

### Build checks

```bash
npm run build
```

This runs the server TypeScript check plus the production frontend build.

## Graph workspace manual verification

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
5. Verify the graph view loads data from `/api/graph`.
6. Select a node to edit it in the sidebar.
7. Create a new work item in the sidebar and confirm it appears in the graph.
8. Create an edge between two nodes and confirm it appears in the graph and edge list.
9. Delete an edge from the sidebar.
10. Change repo/state/track/phase filters and confirm the rendered graph updates.

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

### Delete test data

```bash
curl -X DELETE http://localhost:3000/api/edges/1
curl -X DELETE http://localhost:3000/api/work-items/studio-1
```
