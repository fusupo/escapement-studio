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

### Configure manifest path

By default, the server uses `.manifest/`. Override with:

```bash
MANIFEST_PATH=/path/to/manifest npm run start
```

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
    "id": "studio#1",
    "name": "Server scaffold",
    "kind": "issue",
    "state": "planned",
    "repo": "fusupo/escapement-studio"
  }'
```

### Update a work item

```bash
curl -X PUT http://localhost:3000/api/work-items/studio#1 \
  -H 'content-type: application/json' \
  -d '{"scope_hint": "Initial backend setup"}'
```

### Create an edge

```bash
curl -X POST http://localhost:3000/api/edges \
  -H 'content-type: application/json' \
  -d '{
    "from_id": "studio#1",
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

### Delete test data

```bash
curl -X DELETE http://localhost:3000/api/edges/1
curl -X DELETE http://localhost:3000/api/work-items/studio#1
```
