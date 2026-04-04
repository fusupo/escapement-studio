# Escapement Studio Design Index

The original single design document has been split into a small documentation suite so architectural decisions and implementation contracts can be referenced cleanly while issues are cut and work proceeds.

## Primary docs

- `STUDIO_OVERVIEW.md` — product thesis, core model, high-level architecture, safety principles
- `STUDIO_ARCHITECTURE.md` — implementation-facing architecture and system structure

## Decision records

See `docs/adr/` for locked decisions:

- 001 chat UI strategy
- 002 frontend framework
- 003 runtime target
- 004 session/history strategy
- 005 graph context serialization
- 006 execution orchestration backend
- 007 mutation proposal schema
- 008 graph mutation commit semantics
- 009 browser/server event contract
- 010 planning memory policy
- 011 sub-agent response contracts
- 012 GitHub sync contract
- 013 async run artifact layout

## Contracts

See `docs/contracts/` for implementation-facing specs:

- mutation proposals
- graph commit semantics
- event stream
- planning memory
- sub-agent responses
- GitHub sync
- run artifacts
