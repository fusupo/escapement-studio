# Escapement Studio — project conventions

This file is the home for project-level conventions that should be
applied when working in this repo. It's auto-loaded by Claude Code
when run from the repo root.

## Escapement Settings

- **context-path**: ../escapement-studio-ctx

## Supported platform

Escapement Studio is strictly a desktop-only application. Design and validate
UI changes for desktop browsers, keyboard/mouse interaction, and resized desktop
windows. Mobile/touch layouts and mobile device testing are outside product
scope unless explicitly requested by the user.

## Service size convention

- Services stay under ~400 lines where practical.
- When a service crosses ~600 lines, open an issue to extract a
  sub-service on the next feature that would grow it further.
- God classes (>1000 lines) are a code smell, not a design goal.
- Controllers should be thin. Orchestrator classes that coordinate
  sub-services are fine; service classes that own multiple unrelated
  responsibilities are not.
- When in doubt, pick "extract now" over "extract later" — the cost
  of a premature extraction is smaller than the cost of a deferred
  one.
