# Planning memory contract

## Purpose

Define what belongs in `PLANNING_MEMORY.md` and how it is maintained.

## Principles

Planning memory is:

- durable
- curated
- structural
- approval-gated
- small enough to stay useful

Planning memory is not a transcript or general log.

## Good memory content

- architecture decisions
- durable planning principles
- stable conventions
- intentionally deferred questions worth carrying forward
- reconciliation learnings

## Content to avoid

- ordinary chat fragments
- transient implementation ideas
- raw tool output
- debugging residue
- large sub-agent dumps

## File structure

Suggested sections:

```md
# Planning Memory

## Product Principles
## Architecture Decisions
## Planning Conventions
## Active Open Questions
## Reconciliation Learnings
```

## Write policy

- writes are approval-gated
- prefer targeted updates/replacements over append-only sprawl
- add, replace, or remove bullets/entries intentionally

## Read policy

- V1 may read the full file if it remains compact
- later implementations may read relevant sections selectively
