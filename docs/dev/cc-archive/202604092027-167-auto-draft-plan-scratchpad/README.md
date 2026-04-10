# Issue #167 — Auto-draft plan scratchpad via pi-coding-agent setup-work skill

**Archived:** 2026-04-09
**Branch:** 167-auto-draft-plan-scratchpad (merged, deleted)
**Code SHA at archive:** 186b8af (develop)
**PR:** fusupo/escapement-studio#169 (merged 2026-04-10)
**Status:** Merged

## Summary

Replaced `PlansService.prepare`'s template-stub scratchpad with real LLM-drafted content produced by a new `PlanDrafterService` wrapping `@mariozechner/pi-coding-agent`. The drafter loads the `setup-work` skill spec at runtime from the bundled `escapement` npm dep (`node_modules/escapement/skills/setup-work/SKILL.md`), builds a programmatic-mode prompt with the spec + work item context + a JSON envelope schema, runs a one-shot agent session against the live escapement-studio checkout, parses a JSON envelope from the assistant's final message, and returns it. `PlansService` injects the envelope into the existing scratchpad renderer and refreshes `predicted_files` from `envelope.affected_files`. Failures fail loud — no fallback to stub.

This is the natural follow-up to ADR 014 step 8 (#158) — step 8 made Prepare clickable; this issue makes Prepare actually useful.

## Key Decisions

- **Every Prepare click re-drafts from scratch.** Dropped the carry-forward branch entirely. Reopen is the right primitive for "revise an approved plan".
- **Fail loud on any drafter error.** No fallback to stub. State does NOT transition, existing scratchpad is NOT modified, error propagates as 5xx.
- **Drafter refines `predicted_files`.** On success, `predicted_files` is overwritten with `envelope.affected_files` (when non-empty).
- **Use the bundled `escapement` npm dep as the shared skill source.** `escapement-pi` is already a github: dep. Server reads the skill file via `createRequire(import.meta.url).resolve('escapement/skills/setup-work/SKILL.md')`. Pi interactive users invoke the same skill. Single source of truth, bumped via `npm install escapement@github:fusupo/escapement-pi`.
- **No sub-agent delegation inside the drafter.** pi's one-shot `createAgentSession` model makes sub-agent delegation pointless. Folded the `scratchpad-planner` methodology content into the pi `setup-work` skill directly (`ea6cdd1` on `fusupo/escapement-pi`: 107 → 489 lines).
- **Explicit `@Inject(...)` everywhere.** tsx doesn't emit full TypeScript decorator metadata, so implicit type-based Nest DI silently produces `undefined`. Every new service consumer uses `@Inject(PlanDrafterService)`.
- **Lenient JSON envelope parser.** Real LLM smoke on studio-138 surfaced that Claude occasionally prefixes the JSON with commentary ("Now I have enough to draft the plan. Producing the JSON envelope.\n\n{...}") even when told "no commentary." Parser always extracts the first balanced JSON object via brace-depth tracking with string-literal escape handling. Handles preamble, postamble, and both.

## Files Changed

- `src/modules/plans/plan-drafter.service.ts` (new, ~400 lines)
- `src/modules/plans/plans.service.ts` (prepare() → async, drop carry-forward, extend renderPlanScratchpad with optional draft envelope)
- `src/modules/plans/plans.controller.ts` (prepare() → async)
- `src/modules/plans/plans.module.ts` (register PlanDrafterService)
- `src/modules/plans/types.ts` (new PlanDraftEnvelope / PlanDraftTask / PlanDraftTechnicalNotes interfaces, +39 lines)
- `src/modules/plans/__tests__/plan-drafter.service.test.ts` (new, 24 unit tests)
- `src/modules/plans/__tests__/plans.service.test.ts` (harness drafter mock, async tests, carry-forward test replaced with re-draft tests, +170/−33)
- `package-lock.json` (escapement pinned at `ea6cdd1`)

## Lessons Learned

- **Always call the JSON extractor, not just when the response doesn't start with `{`.** First parser fix only handled preamble; postamble case (`{...}\n\nThat's the plan!`) still failed. Simpler and more robust to always extract the first balanced object.
- **Brace-depth tracking must honor string literals.** `"summary": "contains { and }"` would otherwise throw off the depth counter. Track `inString` + `escape` flags.
- **Use `Object.create(Service.prototype)` test harness + manual property injection** to bypass Nest DI in unit tests. Mirrors the existing pattern in `plans.service.test.ts`.
- **Quality gates:** `npx tsc --noEmit` + `npx vitest run` (331/331) + `npx vite build --config web/vite.config.ts`. Only pre-existing warnings (PlannerChatAdapter.svelte:720 a11y, ExecutionDispatchPanel.svelte:931 unused CSS) remained.

## Related Work

- **Depends on:** #154 (PlansService.prepare introduced), #158 (Plan UI shipped)
- **Follows:** e10632c DI hotfix for PlansController/PlansService on develop (landed direct as a hotfix in this same session)
- **Upstream change:** `fusupo/escapement-pi@ea6cdd1` — expanded `setup-work` SKILL.md 107 → 489 lines, ported scratchpad-planner methodology + CC setup-work richer content + programmatic-mode section

## Archive Contents

- `README.md` — this summary
- `SCRATCHPAD_167.md` — the comprehensive implementation plan written by setup-work
- `SESSION_LOG_1.md` — converted from SESSION_LOG_1.jsonl (3856 entries) at code SHA 186b8af
