# Escapement Studio — Architecture Diagrams

This directory contains PlantUML source for component and sequence diagrams
that document how Escapement Studio fits together. They complement the
narrative in `ARCHITECTURE.md` (one level up from here).

## Layout

```
docs/diagrams/
├── README.md                        # this file
├── ARCHITECTURE.md                  # narrative guide that references every diagram
├── components/                      # structural diagrams (PlantUML source)
│   ├── 01-system-overview.puml
│   ├── 02-backend-modules.puml
│   ├── 03-backend-services.puml
│   ├── 04-frontend-structure.puml
│   ├── 05-filesystem-layout.puml
│   └── 06-hsm-state-chart.puml
├── sequences/                       # behavioral diagrams (PlantUML source)
│   ├── 01-plan-lifecycle.puml
│   ├── 02-execution-run.puml
│   ├── 03-graph-mutation-approval.puml
│   ├── 04-memory-write-approval.puml
│   ├── 05-github-sync-approval.puml
│   ├── 06-merged-pr-disposition.puml
│   ├── 07-cancel-work-item.puml
│   ├── 08-github-cache-sweep.puml
│   ├── 09-startup-reconcile.puml
│   └── 10-subagent-delegation.puml
└── rendered/                        # pre-rendered PNG output (white background)
    ├── components/                  # mirrors components/ structure + filenames
    │   ├── 01-system-overview.png
    │   ├── 02-backend-modules.png
    │   ├── 03-backend-services.png
    │   ├── 04-frontend-structure.png
    │   ├── 05-filesystem-layout.png
    │   └── 06-hsm-state-chart.png
    └── sequences/                   # mirrors sequences/ structure + filenames
        ├── 01-plan-lifecycle.png
        ├── 02-execution-run.png
        ├── 03-graph-mutation-approval.png
        ├── 04-memory-write-approval.png
        ├── 05-github-sync-approval.png
        ├── 06-merged-pr-disposition.png
        ├── 07-cancel-work-item.png
        ├── 08-github-cache-sweep.png
        ├── 09-startup-reconcile.png
        └── 10-subagent-delegation.png
```

## Reading the diagrams

- **Component diagrams** show static structure: modules, services, classes,
  filesystem, external integrations. Start with `01-system-overview`,
  then drill into `02-backend-modules` for NestJS wiring, and
  `03-backend-services` for the concrete services and their
  collaborations.
- **Sequence diagrams** show how essential operations flow across components
  over time. Start with `01-plan-lifecycle` and `02-execution-run` for the
  happy path, then read the others for specific flows (disposition, cancel,
  sync, etc.).

## Pre-rendered PNGs

`rendered/` contains ready-to-view PNG versions of every diagram with
filenames that mirror the source `.puml` files, so the numeric ordering
is preserved. PNG is used (instead of SVG) because PlantUML's SVG output
is transparent by default, which is hard to read on dark backgrounds —
PNG always has an opaque white background.

### Component diagrams

| # | Source | Rendered |
|---|---|---|
| 01 | [`components/01-system-overview.puml`](components/01-system-overview.puml) | [`rendered/components/01-system-overview.png`](rendered/components/01-system-overview.png) |
| 02 | [`components/02-backend-modules.puml`](components/02-backend-modules.puml) | [`rendered/components/02-backend-modules.png`](rendered/components/02-backend-modules.png) |
| 03 | [`components/03-backend-services.puml`](components/03-backend-services.puml) | [`rendered/components/03-backend-services.png`](rendered/components/03-backend-services.png) |
| 04 | [`components/04-frontend-structure.puml`](components/04-frontend-structure.puml) | [`rendered/components/04-frontend-structure.png`](rendered/components/04-frontend-structure.png) |
| 05 | [`components/05-filesystem-layout.puml`](components/05-filesystem-layout.puml) | [`rendered/components/05-filesystem-layout.png`](rendered/components/05-filesystem-layout.png) |
| 06 | [`components/06-hsm-state-chart.puml`](components/06-hsm-state-chart.puml) | [`rendered/components/06-hsm-state-chart.png`](rendered/components/06-hsm-state-chart.png) |

### Sequence diagrams

| # | Source | Rendered |
|---|---|---|
| 01 | [`sequences/01-plan-lifecycle.puml`](sequences/01-plan-lifecycle.puml) | [`rendered/sequences/01-plan-lifecycle.png`](rendered/sequences/01-plan-lifecycle.png) |
| 02 | [`sequences/02-execution-run.puml`](sequences/02-execution-run.puml) | [`rendered/sequences/02-execution-run.png`](rendered/sequences/02-execution-run.png) |
| 03 | [`sequences/03-graph-mutation-approval.puml`](sequences/03-graph-mutation-approval.puml) | [`rendered/sequences/03-graph-mutation-approval.png`](rendered/sequences/03-graph-mutation-approval.png) |
| 04 | [`sequences/04-memory-write-approval.puml`](sequences/04-memory-write-approval.puml) | [`rendered/sequences/04-memory-write-approval.png`](rendered/sequences/04-memory-write-approval.png) |
| 05 | [`sequences/05-github-sync-approval.puml`](sequences/05-github-sync-approval.puml) | [`rendered/sequences/05-github-sync-approval.png`](rendered/sequences/05-github-sync-approval.png) |
| 06 | [`sequences/06-merged-pr-disposition.puml`](sequences/06-merged-pr-disposition.puml) | [`rendered/sequences/06-merged-pr-disposition.png`](rendered/sequences/06-merged-pr-disposition.png) |
| 07 | [`sequences/07-cancel-work-item.puml`](sequences/07-cancel-work-item.puml) | [`rendered/sequences/07-cancel-work-item.png`](rendered/sequences/07-cancel-work-item.png) |
| 08 | [`sequences/08-github-cache-sweep.puml`](sequences/08-github-cache-sweep.puml) | [`rendered/sequences/08-github-cache-sweep.png`](rendered/sequences/08-github-cache-sweep.png) |
| 09 | [`sequences/09-startup-reconcile.puml`](sequences/09-startup-reconcile.puml) | [`rendered/sequences/09-startup-reconcile.png`](rendered/sequences/09-startup-reconcile.png) |
| 10 | [`sequences/10-subagent-delegation.puml`](sequences/10-subagent-delegation.puml) | [`rendered/sequences/10-subagent-delegation.png`](rendered/sequences/10-subagent-delegation.png) |

## Rendering manually

If you edit a source file, regenerate its PNG with:

```bash
# Render a single diagram to PNG into the rendered/ mirror
plantuml -tpng -o "$PWD/docs/diagrams/rendered/components" \
  docs/diagrams/components/01-system-overview.puml

# Render every source file (PlantUML names the output after @startuml <name>,
# so mv it back into place under the source's numeric prefix)
for puml in docs/diagrams/components/*.puml docs/diagrams/sequences/*.puml; do
  subdir=$(basename "$(dirname "$puml")")
  base=$(basename "$puml" .puml)
  tmp=$(mktemp -d)
  plantuml -tpng -o "$tmp" "$puml"
  mv "$tmp"/*.png "docs/diagrams/rendered/$subdir/$base.png"
  rmdir "$tmp"
done

# SVG instead of PNG: swap -tpng for -tsvg
# Via the plantuml Docker image:
docker run --rm -v "$PWD:/work" plantuml/plantuml \
  -tpng docs/diagrams/components/01-system-overview.puml
```

Note: PlantUML names the output file after the `@startuml <name>` directive
in each source file, so its default output filename drops the numeric
prefix. The `rendered/` mirror in this repo preserves the numeric prefix
by moving the output back into place after `plantuml` runs.

IDE plugins (VS Code "PlantUML", JetBrains "PlantUML integration") render
the diagrams inline as you edit and do not need the `rendered/` mirror.

## Grounding

Each diagram is traceable back to code. Inline comments in the `.puml`
sources cite the relevant files (e.g. `src/modules/graph/work-item-hsm.service.ts`)
so they can be kept honest as the code evolves. If a diagram drifts, the
code is the source of truth — update the diagram to match.
