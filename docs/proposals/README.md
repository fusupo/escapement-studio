# Escapement Studio — Migration Proposals

This directory contains proposal docs for incrementally refactoring the
backend toward the target architecture described in the chat thread that
spawned this folder. The goal of each proposal is **one mergeable PR**
with clear motivation, file-level changes, tests, and acceptance criteria.

The migration is deliberately sequenced so that:

1. Every phase is independently valuable — you can stop after any phase
   and the codebase is strictly better than before
2. Every phase is revertable as a single PR
3. No phase requires a feature freeze
4. NestJS stays — the target architecture is entirely compatible with Nest;
   only the social rule about cross-module imports changes

## Phase table

Before reading any individual phase doc, read
[`assessment.md`](assessment.md) — the grounded reference that
captures why migration vs rebuild, what smells exist with line
pointers, and how phases map to current code. The phase docs assume
that context.

| # | Phase | Proposal doc | Net outcome | fwdRef |
|---|---|---|---|---:|
| 0 | Platform bus (`@nestjs/cqrs`) | [`phase-0-platform-bus.md`](phase-0-platform-bus.md) | Command + event bus infrastructure via the Nest-native CQRS package. No production code touched. | 0 |
| 1 | Kill the HSM shadow vocabulary | [`phase-1-hsm-action-handlers.md`](phase-1-hsm-action-handlers.md) | Move `HsmActionHandlers` to ExecutionModule, rewrite to runtime signature, delete `HsmGuardHandlers` + `createRunRecord` action + `kickOffPlanDrafter` shadow. Named, testable, single-sourced. | −1 |
| 2 | Route `WorkItemsController` through the command bus | [`phase-2-work-items-controller-command-bus.md`](phase-2-work-items-controller-command-bus.md) | Six commands for cancel/delete/transition/prepare/reopen. Controller injects only `CommandBus` + same-module services. | −2 |
| 3 | Extract `RunDispositionService` | [`phase-3-run-disposition-service.md`](phase-3-run-disposition-service.md) | Merged-PR close / archive-and-close / cancel / delete clusters move out of the god class into a dedicated sub-service. God class drops ~800 lines. | 0 |
| 4 | Carve remaining sub-services out of `ExecutionService` | [`phase-4-execution-sub-services.md`](phase-4-execution-sub-services.md) | `RunStore`, `WorktreeService`, `ScratchpadService`, `RunInteractionService`, `PullRequestService`. God class drops from ~2500 to ~500. | 0 |
| 5 | Event-driven cross-context calls (picked per event) | [`phase-5-event-driven-cross-context.md`](phase-5-event-driven-cross-context.md) | `WorkItemMergedEvent`, `RunCompletedEvent`, `PullRequestTruthRefreshedEvent`, `WorkItemDeletedEvent`. Bespoke callback handshake retired. | −1 |
| 6 | `PlatformModule` for `SQLiteService` + move `GitHubBatchCache` to `GitHubModule` | [`phase-6-platform-module.md`](phase-6-platform-module.md) | Infrastructure out of GraphModule. External-state caching home-moved. Transitive cycles through Graph collapse. | −3 |
| 7 | Planner tool registry | [`phase-7-planner-tool-registry.md`](phase-7-planner-tool-registry.md) | 10 planner tools move to per-file factories. `ProposalStateService` owns staging state. `PlanningService` drops from ~1380 to ~500. | 0 |
| 8 | Delete dead code + rename reconciliation | [`phase-8-delete-dead-code.md`](phase-8-delete-dead-code.md) | Delete `GitModule`, four legacy Svelte components, orphaned `createHsmRunRecord`. Rename `ReconciliationService` → `DriftReportService` (URL preserved for compat). | −1 |
| 9 | Review pass | [`phase-9-review-pass.md`](phase-9-review-pass.md) | Unwrap residual forwardRefs, dedup run scaffolding audit, ratify service-size convention in CLAUDE.md. | −1 to −3 |

**Starting forwardRef count:** 11 (verified by
`grep -c 'forwardRef(' src/modules/*/*.module.ts` as of
2026-04-12).
**Target after Phase 9:** 0–1.

## How to read the proposals

Each phase doc has the same structure:

- **Motivation** — what's wrong today, with file + line pointers
- **Scope** — what's in, what's deliberately out
- **File changes** — every file that changes, with before/after snippets
- **Module wiring details** — NestJS specifics (provider order, forwardRefs,
  lifecycle hooks)
- **Tests** — new and modified
- **Acceptance criteria** — a boolean checklist you can self-review against
- **Known remaining drift** — things this phase leaves imperfect, with a
  pointer to when they get fixed
- **Next steps** — what the next phase does

The docs are written so a single focused session (1–3 days) can execute
them end-to-end. They are deliberately concrete: if you find yourself
asking "what did they mean by X?", the doc has failed its job.

## Ground rules for all phases

1. **No feature freeze.** At every phase, the app still starts, tests
   still pass, the existing HTTP surface is unchanged.
2. **Tests are the safety net.** Every phase preserves or extends the
   existing test suite. No test is deleted without a replacement.
3. **Behavior change is out of scope.** Refactors move code; they do not
   fix bugs. If a bug is discovered during a phase, file a separate issue
   and fix it in a dedicated PR before or after the phase (not within).
4. **Incremental forwardRef removal.** Each phase may remove 0–4
   forwardRefs. The count starts at **11** (as measured by
   `grep -o 'forwardRef(' src/modules/*/*.module.ts | wc -l`) and
   trends toward 0 over the migration. Track it in the PR description.
5. **Decorator scanning stays.** `@Cron`, `@Sse`, `@Controller`,
   `@CommandHandler`, `@EventsHandler` are all Nest-native; the migration
   doesn't hand-roll anything Nest already provides.
