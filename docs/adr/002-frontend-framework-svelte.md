# ADR 002: Frontend framework

- **Status:** accepted
- **Date:** 2026-04-04

## Decision

Use Svelte for the Studio frontend.

## Rationale

- lightweight fit for a custom interactive application
- good for panel-based UI and stateful interaction flows
- suitable host for D3 graph components and mutation approval UI
- compatible with a Studio adapter around pi-web-ui

## Consequences

- frontend issues should assume Vite + Svelte
- D3 should be embedded inside Svelte components
- Studio-specific state management should be designed around Svelte patterns rather than a heavier framework model
