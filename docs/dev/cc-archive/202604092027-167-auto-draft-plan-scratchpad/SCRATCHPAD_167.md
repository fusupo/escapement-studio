# Auto-draft plan scratchpad via pi-coding-agent setup-work skill — #167

## Issue Details

- **Repository:** fusupo/escapement-studio
- **GitHub URL:** https://github.com/fusupo/escapement-studio/issues/167
- **State:** open
- **Labels:** (none)
- **Milestone:** none
- **Assignees:** unassigned
- **Author:** fusupo
- **Related Issues:**
  - Depends on: #154 (PlansService.prepare introduced), #158 (UI shipped)
  - Blocks: none
  - Related: ADR 014 (overall epic, complete)

## Description

Today, `PlansService.prepare` writes a stub scratchpad with `(to be filled in)` placeholders. The work item transitions `planned → drafting` but the scratchpad has no real content. This issue reverses ADR 014 step 4's deliberate "structure only" decision and wires `PlansService.prepare` to call out to a pi-coding-agent session that drafts the entire scratchpad in a single shot, using the richer `setup-work` skill spec from `node_modules/escapement/skills/setup-work/SKILL.md` (just expanded in fusupo/escapement-pi `ea6cdd1`).

When the user clicks **Prepare plan** in Studio:

1. PlansService fetches the issue body and builds the work item context
2. `PlanDrafterService.draft()` resolves the canonical setup-work skill file at runtime, builds a programmatic-mode prompt, calls `createAgentSession` with read-only tools (Read + Grep + Bash), awaits the session, parses a JSON envelope from the assistant's final message
3. PlansService injects the envelope into `renderPlanScratchpad`, refreshes `predicted_files` from `envelope.affected_files`, writes the canonical scratchpad, transitions state, returns

On any drafter failure (network, malformed JSON, agent error): the POST returns a 5xx, the work item state does NOT transition, the existing scratchpad is NOT modified.

## Summary

Replace `PlansService.prepare`'s template-stub scratchpad with a real LLM-drafted scratchpad produced by a new `PlanDrafterService` that wraps `@mariozechner/pi-coding-agent`'s `createAgentSession` API. The drafter loads the setup-work skill spec at runtime from the bundled `escapement` npm package, builds a prompt that includes the spec + work item context + a JSON envelope schema, runs a one-shot agent session against the live escapement-studio checkout (so the agent can Grep/Read the actual codebase), parses the JSON envelope, and returns it. PlansService injects the envelope into the existing scratchpad renderer and updates the work item's `predicted_files` from the envelope's affected files. Failures fail loud — no fallback to stub.

This is the natural follow-up to ADR 014 step 8 (#158) which shipped the UI buttons. Step 8 made Prepare clickable; this issue makes Prepare actually useful.

## Acceptance Criteria

- [ ] `PlanDrafterService` exists at `src/modules/plans/plan-drafter.service.ts`, exported from `PlansModule`, explicitly `@Inject(PlanDrafterService)` everywhere it is consumed (DI gotcha avoidance)
- [ ] `PlanDrafterService.draft(workItem, issueBody)` returns a typed `PlanDraftEnvelope` containing summary, acceptance_criteria, implementation_tasks, affected_files, questions, assumptions, blockers, technical_notes
- [ ] The drafter resolves `node_modules/escapement/skills/setup-work/SKILL.md` via `createRequire(import.meta.url).resolve('escapement/skills/setup-work/SKILL.md')` and reads the file at draft time (no caching) — picks up future skill updates after `npm install`
- [ ] `PlansService.prepare` is now `async` and calls `PlanDrafterService.draft` after `assertPreparable` and before any state transition. On success: scratchpad is rendered with drafted content, `predicted_files` is refreshed from `envelope.affected_files`, state transitions `planned → drafting`. On failure: state does NOT transition, existing scratchpad is NOT modified, the error propagates as a 5xx
- [ ] Every Prepare click runs the full drafter — no carry-forward of existing scratchpad content (replaces today's preserve-edits behavior). Reopen is the right primitive for "revise an approved plan"
- [ ] `PlansController.prepare` awaits the async service call
- [ ] `package-lock.json` updated to pin `escapement` at `ea6cdd1` or later. After `npm install`, `node_modules/escapement/skills/setup-work/SKILL.md` is 489+ lines
- [ ] New unit tests in `src/modules/plans/__tests__/plan-drafter.service.test.ts`: successful parse (3+ tests covering different envelope shapes), malformed JSON throws, agent session throws, prompt structure includes skill body + work item context + envelope schema
- [ ] Existing `plans.service.test.ts` tests updated for the new behavior: `transitions planned → drafting` test mocks a drafter; `is idempotent on drafting → drafting and carries existing scratchpad forward` test is REPLACED with `prepare always re-drafts even when scratchpad exists`; new tests for drafter-failure-blocks-transition and drafter-failure-preserves-existing-scratchpad
- [ ] All quality gates green: `npx tsc --noEmit`, `npx vitest run`, `npx vite build --config web/vite.config.ts`
- [ ] Manual smoke: dev server, click Prepare on studio-138 (planned), verify scratchpad has real drafted content (not `(to be filled in)`), verify Review modal renders the drafted content, verify state transitions to `drafting`. Click Prepare again, verify it re-drafts (the drafted content may differ on the second run)

## Branch Strategy

- **Base branch:** `develop` (currently at `e10632c`, the DI hotfix)
- **Feature branch:** `167-auto-draft-plan-scratchpad`
- **Current branch:** `develop`

## Implementation Plan

### Setup

- [ ] Fetch latest from `origin/develop`
- [ ] Create and checkout `167-auto-draft-plan-scratchpad` from `origin/develop`

### Implementation Tasks

#### Task 1: Bump escapement dependency to ea6cdd1+

Foundation step. Without this, the drafter would read the OLD 106-line skill, defeating the entire point.

- **Files:** `package-lock.json` (and possibly `package.json` if SHA-pin is desired)
- **Command:** `npm install escapement@github:fusupo/escapement-pi` (re-resolves the github: tag to latest main; should pick up `ea6cdd1`)
- **Verify:** `wc -l node_modules/escapement/skills/setup-work/SKILL.md` shows 489 lines (was 106)
- **Why:** prerequisite for every subsequent task — if the file isn't in node_modules, the drafter has nothing to read
- **Testing:** manual file size check + `npx tsc --noEmit` (no source changes here, but lockfile change should not break anything)

#### Task 2: Add `PlanDraftEnvelope` types

Define the shape the drafter returns, in the existing types module. Match the issue body's envelope spec exactly.

- **Files:** `src/modules/plans/types.ts`
- **What:** add interfaces:
  ```ts
  export interface PlanDraftEnvelope {
    summary: string;
    acceptance_criteria: string[];
    implementation_tasks: PlanDraftTask[];
    affected_files: string[];
    questions: string[];
    assumptions: string[];
    blockers: string[];
    technical_notes: PlanDraftTechnicalNotes;
  }

  export interface PlanDraftTask {
    description: string;
    files: string[];
    rationale: string;
    testing: string;
  }

  export interface PlanDraftTechnicalNotes {
    architecture: string;
    approach: string;
    challenges: string;
  }
  ```
- **Why:** typed contract between the drafter, the renderer, and the test suite. Foundation type.
- **Testing:** typecheck — `npx tsc --noEmit`

#### Task 3: Create PlanDrafterService skeleton

New service file with the constructor + method signature, but the body throws "not implemented." Lets us register it in the module before the implementation is complete.

- **Files:** `src/modules/plans/plan-drafter.service.ts` (new)
- **What:**
  - `@Injectable()` class `PlanDrafterService`
  - Logger property
  - Constructor takes no dependencies (the drafter doesn't need WorkItemsService — it gets the work item passed in)
  - Method `async draft(workItem: WorkItemRecord, issueBody: string | null): Promise<PlanDraftEnvelope>` that throws `new Error("PlanDrafterService.draft not implemented")` for now
- **Why:** lets Task 4 (module wiring) and Task 8 (PlansService integration) progress in parallel without waiting for the actual LLM logic
- **Testing:** typecheck + a smoke test that constructs the service via Object.create and verifies `draft()` rejects with the not-implemented error

#### Task 4: Register PlanDrafterService in PlansModule

- **Files:** `src/modules/plans/plans.module.ts`
- **What:** add `PlanDrafterService` to `providers` and `exports`
- **Why:** makes the service injectable into PlansService and other consumers
- **Testing:** `npx tsc --noEmit` + `npx vitest run src/modules/plans` (should still pass — service isn't called yet)

#### Task 5: Implement skill resolution + prompt building

Load the skill file at runtime and build the agent prompt. No LLM call yet.

- **Files:** `src/modules/plans/plan-drafter.service.ts`
- **What:**
  - Add private method `loadSkillBody(): string` that uses `createRequire(import.meta.url).resolve('escapement/skills/setup-work/SKILL.md')` and `readFileSync(path, 'utf8')`. Wrap in try/catch and re-throw with a clear error message if the file is missing.
  - Add private method `buildDraftPrompt({ skillBody, workItem, issueBody }): string` that returns a multi-part prompt:
    1. **Header**: "You are operating in PROGRAMMATIC MODE on behalf of Escapement Studio's PlansService. Follow the setup-work skill spec below verbatim. There is no human user. Surface unresolved questions in the JSON envelope's `questions` field."
    2. **Skill spec**: the full skill body from `loadSkillBody()`
    3. **Work item context**: id, name, repo, issue_url, scope_hint, predicted_files (current), branch
    4. **Issue body**: the issueBody parameter (or "(unavailable)")
    5. **JSON envelope schema**: a `JSON.stringify` example matching `PlanDraftEnvelope`
    6. **Final instruction**: "Return ONLY the JSON envelope. No markdown fences, no commentary. Your final assistant message must parse as JSON matching the schema above."
- **Why:** isolates the deterministic part (prompt construction) from the LLM call so it can be unit-tested without mocking pi-coding-agent
- **Testing:** unit test in `__tests__/plan-drafter.service.test.ts`:
  - `loadSkillBody returns content from node_modules/escapement` (depends on Task 1 having bumped the lockfile)
  - `buildDraftPrompt includes skill body, work item id, issue body, envelope schema markers`

#### Task 6: Wire createAgentSession + JSON envelope parsing

The actual LLM call. Mirrors `SubAgentService.runDelegation` (lines 66-101).

- **Files:** `src/modules/plans/plan-drafter.service.ts`
- **What:**
  - In `draft()`, after building the prompt:
    ```ts
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: SessionManager.inMemory(process.cwd()),
      tools: [
        createReadTool(process.cwd()),
        createGrepTool(process.cwd()),
        createBashTool(process.cwd()),
      ],
    });
    if (modelFallbackMessage) this.logger.warn(modelFallbackMessage);
    try {
      await session.prompt(prompt);
    } finally {
      session.dispose();
    }
    const text = session.getLastAssistantText()?.trim() ?? "";
    return this.parseEnvelope(text);
    ```
  - Add private `parseEnvelope(text: string): PlanDraftEnvelope` that:
    - Strips optional markdown code fences (`\`\`\`json ... \`\`\``)
    - `JSON.parse`s the result
    - Validates required fields exist with the right types (throw `Error` with a clear message on mismatch)
    - Returns the typed envelope
  - On any throw inside `draft()`: log via `this.logger.error`, re-throw so PlansService.prepare's caller sees the error
- **Why:** the meat of the feature
- **Testing:** unit tests with `vi.mock("@mariozechner/pi-coding-agent", ...)`:
  - Successful: mock returns valid JSON envelope text, parsed correctly
  - Markdown fences: mock returns ```\`\`\`json\n{...}\n\`\`\` ```, parsed correctly
  - Malformed JSON: mock returns "not json", throws
  - Missing required field: mock returns `{}`, throws with "summary" or whatever's missing
  - createAgentSession throws: drafter throws

#### Task 7: Extend renderPlanScratchpad to inject draft envelope

Backwards-compatible signature: add an optional `draft?: PlanDraftEnvelope` parameter. When omitted, falls back to current stub-rendering (so existing tests that don't care about drafts still pass). When provided, the renderer fills Summary / Acceptance Criteria / Implementation Plan / Affected Files / Questions / Concerns / Assumptions / Blockers / Technical Notes from the envelope.

- **Files:** `src/modules/plans/plans.service.ts`
- **What:**
  - Add parameter to `renderPlanScratchpad(workItem, issueBody, templates, draft?)`
  - When `draft` is provided:
    - Summary section: render `draft.summary` instead of the `<!-- ... -->` placeholder
    - Acceptance Criteria section: render `draft.acceptance_criteria.map(c => `- [ ] ${c}`).join("\n")`
    - Implementation Plan section: render each task as a checklist item with files / why / testing sub-bullets matching the format in the new skill
    - Affected Files section: render `draft.affected_files.map(f => `- ${f}`).join("\n")` (replaces the predicted_files-based seeding)
    - Questions / Concerns section: render `draft.questions` under `### Clarifications Needed`, `draft.assumptions` under `### Assumptions Made`, `draft.blockers` under `### Blocked By`
    - Add a new `## Technical Notes` section with `### Architecture Considerations`, `### Implementation Approach`, `### Potential Challenges` from `draft.technical_notes.architecture/approach/challenges`
  - When `draft` is omitted: fall back to current rendering (preserve existing test compatibility)
  - Studio Issue Templates section stays as-is (rendered post-draft, project metadata, not LLM-drafted)
- **Why:** the renderer is the only place that knows how to format scratchpad sections — extending it here keeps the logic centralized
- **Testing:** unit tests in `plans.service.test.ts`:
  - `renderPlanScratchpad without draft preserves current stub behavior` (existing tests)
  - `renderPlanScratchpad with draft injects summary` (new test)
  - `renderPlanScratchpad with draft injects implementation tasks with files+why+testing structure` (new test)
  - `renderPlanScratchpad with draft injects technical notes section` (new test)

#### Task 8: Wire PlansService.prepare to call PlanDrafterService

The integration point. PlansService becomes async, calls the drafter, injects the envelope, refreshes predicted_files, fails loud on drafter errors.

- **Files:** `src/modules/plans/plans.service.ts`
- **What:**
  - Add `@Inject(PlanDrafterService) private readonly drafter: PlanDrafterService` to the constructor
  - Change `prepare(workItemId: string): PlanResponse` → `async prepare(workItemId: string): Promise<PlanResponse>`
  - **Reorder the body**: fetch issue body BEFORE state transition (so drafter has it). Call `await this.drafter.draft(workItem, issueBody)` BEFORE the state transition. If the drafter throws, the error propagates up — work item state is unchanged, no scratchpad written, no metadata written.
  - On drafter success:
    - Render scratchpad with `renderPlanScratchpad(workItem, issueBody, templates, envelope)`
    - Write canonical scratchpad (overwriting any existing content — every prepare re-drafts)
    - Refresh `predicted_files` via `workItemsService.update(id, { predicted_files: envelope.affected_files })` (only if envelope has at least one file)
    - Transition state `planned → drafting` (existing logic)
    - Update plan metadata (existing logic)
    - Return PlanResponse
  - **Drop the carry-forward branch entirely** — no more `if (existsSync(canonicalPath) && existing.trim().length > 0) { scratchpadContent = existing; }`. Re-prepare always re-drafts.
  - Drop `buildPlanScratchpad` and `generateSkeleton` if no longer used (they were just convenience wrappers around `renderPlanScratchpad` + issue body fetch)
- **Why:** this is the actual user-visible behavior change
- **Testing:** see Task 10

#### Task 9: Make controller awaits

- **Files:** `src/modules/plans/plans.controller.ts`
- **What:** change `prepare(@Param... workItemId): PlanResponse` → `async prepare(@Param... workItemId): Promise<PlanResponse> { return this.plansService.prepare(workItemId); }`
  - NestJS auto-awaits returned promises, but explicit `async`/`Promise` is clearer and makes the type signature honest
- **Why:** the service method is now async
- **Testing:** typecheck + existing controller behavior unchanged

#### Task 10: Update existing PlansService tests for the new flow

The big test surgery. Many existing tests need to mock PlanDrafterService and add `await`s. Some tests need deletion (carry-forward semantics gone).

- **Files:** `src/modules/plans/__tests__/plans.service.test.ts`
- **What:**
  - Update `makeHarness` to inject a fake `PlanDrafterService` with a configurable `draft` mock that defaults to returning a valid envelope
  - Add `drafter` to the `Harness` interface so tests can override it per-test
  - Update `prepare` tests (all need `await`):
    - **`transitions planned → drafting and writes canonical scratchpad`**: keep, but now assert the drafted envelope was injected (e.g. `expect(content).toContain("Drafted summary text")`). Mock the drafter to return a known envelope.
    - **`is idempotent on drafting → drafting and carries existing scratchpad forward`**: DELETE. Replaced by `re-drafts on every Prepare even when scratchpad exists`.
    - **`regenerates skeleton if canonical scratchpad exists but is empty`**: DELETE. Replaced by `always re-drafts`.
  - Add new tests:
    - `prepare always re-drafts via drafter even when scratchpad exists` — pre-write a scratchpad, call prepare, assert the drafter was called and the new content replaced the old
    - `prepare on drafter failure does not transition state` — mock drafter to throw, assert work item stays planned
    - `prepare on drafter failure does not modify existing scratchpad` — pre-write content, mock drafter to throw, assert content unchanged
    - `prepare refreshes predicted_files from drafter envelope.affected_files` — mock returns envelope with specific files, assert workItemsService.update called with predicted_files
    - `prepare leaves predicted_files unchanged when envelope.affected_files is empty` — mock returns empty array, assert no predicted_files update
  - Update rejection tests (`rejects prepare when work item is in {state}`): should still work, but need `await expect(...).rejects.toThrow(...)` since the method is async now
- **Why:** test changes mirror behavior changes
- **Testing:** `npx vitest run src/modules/plans` should be all green

#### Task 11: Add PlanDrafterService unit tests

- **Files:** `src/modules/plans/__tests__/plan-drafter.service.test.ts` (new)
- **What:**
  - vi.mock `@mariozechner/pi-coding-agent` at the top
  - Tests:
    - `loadSkillBody resolves the bundled skill file` — uses real createRequire, asserts the file content includes a known marker from the new skill (e.g., "Invocation Modes")
    - `buildDraftPrompt embeds the skill body` — pass a fake skill body, assert the result contains it
    - `buildDraftPrompt embeds work item context and issue body` — assert id, name, repo, issue body all present
    - `buildDraftPrompt embeds the JSON envelope schema marker` — assert the prompt contains an example envelope JSON
    - `draft returns parsed envelope on successful agent run` — mock createAgentSession to return a session whose `getLastAssistantText` returns valid JSON
    - `draft handles markdown-fenced JSON in the agent response` — mock returns ` ```json\n{...}\n``` `
    - `draft throws on malformed JSON` — mock returns "not json", assert throw
    - `draft throws when the envelope is missing required fields` — mock returns `{}`, assert throw mentions a missing field
    - `draft throws when createAgentSession itself throws` — mock throws, drafter throws
- **Why:** isolated tests for the drafter without needing PlansService context
- **Testing:** `npx vitest run plan-drafter`

#### Task 12: Quality gates + manual smoke

- **Files:** none (verification only)
- **What:**
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `npx vite build --config web/vite.config.ts`
  - Restart dev server, click Prepare on a planned work item (e.g. studio-138), verify the scratchpad in the Review modal contains drafted content (not `(to be filled in)` placeholders), verify state transitioned to `drafting`. Click Prepare again, verify it re-drafted (content may differ).
- **Why:** prove end-to-end before commits
- **Testing:** see above

### Quality Checks

- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run`
- [ ] `npx vite build --config web/vite.config.ts`
- [ ] Self-review the diff for scope hygiene (no unrelated changes, no speculative abstractions)
- [ ] Verify each acceptance criterion is met
- [ ] Manual smoke test on studio-138 in dev server

### Documentation

- [ ] No README updates expected — public behavior is "Prepare button now produces real plans" which is self-evident from the UI
- [ ] No new ADR — this is a course-correction within ADR 014, not a new architectural decision
- [ ] Inline JSDoc comments on `PlanDrafterService` methods explaining the prompt-building strategy

## Affected Files

- `package-lock.json` — bump escapement to ea6cdd1+
- `src/modules/plans/types.ts` — add `PlanDraftEnvelope`, `PlanDraftTask`, `PlanDraftTechnicalNotes` interfaces
- `src/modules/plans/plan-drafter.service.ts` — new service (resolves skill, builds prompt, calls createAgentSession, parses envelope)
- `src/modules/plans/plans.module.ts` — register and export `PlanDrafterService`
- `src/modules/plans/plans.service.ts` — `@Inject(PlanDrafterService)`, async prepare, drafter integration, extended `renderPlanScratchpad` signature, drop carry-forward branch
- `src/modules/plans/plans.controller.ts` — async/await on prepare
- `src/modules/plans/__tests__/plans.service.test.ts` — harness updated with drafter mock, tests rewritten for re-draft semantics
- `src/modules/plans/__tests__/plan-drafter.service.test.ts` — new unit test file

## Technical Notes

### Architecture Considerations

- **Single source of truth for the drafting spec.** The skill at `node_modules/escapement/skills/setup-work/SKILL.md` (sourced from the `escapement` GitHub dependency) is the canonical drafting instructions. PlansService reads it at runtime — no inline duplication, no `escapement-studio/docs/` copy. Bumping the dep is the only way to change drafter behavior, which is correct.
- **DI gotcha avoidance.** Per the lesson learned in `e10632c` (the hotfix), every NestJS injection in this codebase needs explicit `@Inject(SomeService)` because tsx doesn't emit full decorator metadata. New `PlanDrafterService` consumers get explicit decorators.
- **Async propagation.** `prepare` going async cascades through the controller (already done in #154 for other Plans endpoints? — verify) and any callers that test it synchronously. The test harness's `Object.create` pattern handles this naturally — tests just need `await`.
- **Failure semantics.** Drafter throws → PlansService.prepare doesn't catch → NestJS converts to 500 → Studio UI shows error in the existing Prepare loading-state error path. No new error UI plumbing needed in #158's frontend.
- **Drafter has full repo read access via `cwd: process.cwd()`.** This means the agent can Grep the actual escapement-studio source while drafting, which dramatically improves plan quality vs. issue-body-only drafting. For cross-repo work items (e.g. a work item for a different `repo` field), the agent still grep-reads escapement-studio — that's a known limitation noted in the issue's "out of scope."

### Implementation Approach

Mirrors `SubAgentService.runDelegation` (`src/modules/planning/sub-agent.service.ts:38-138`) very closely. Same imports, same `createAgentSession({ cwd, sessionManager, tools })` shape, same `await session.prompt() / session.dispose() / session.getLastAssistantText()` pattern, same JSON envelope parsing approach. The only meaningful differences:

1. Tools list omits any write tools (we want read-only — Read + Grep + Bash, no Edit/Write)
2. Prompt structure is different (skill body + work item + envelope schema, not focus paths + role + envelope schema)
3. No artifact-dir bookkeeping (PlansService writes to the canonical scratchpad path, not a separate run dir)
4. No "recent runs" buffer or metadata tracking — the drafter is stateless

The closest existing reference is SubAgentService — when in doubt, copy its pattern.

### Potential Challenges

- **Lockfile bump may pull in unrelated escapement changes.** The github: dep tracks main, so `npm install` will pull `ea6cdd1` AND any subsequent commits. If anything else has been pushed to escapement-pi main since `ea6cdd1`, those changes come along too. Mitigation: pin to exact SHA in package.json by changing `"escapement": "github:fusupo/escapement-pi"` → `"escapement": "github:fusupo/escapement-pi#ea6cdd1"`. **Decision needed**: do we want to pin? Argument for: reproducibility. Argument against: we lose automatic skill updates on the next deploy.
  - **My take**: don't pin; track main. The whole point of the runtime-load architecture is to pick up future skill improvements. If a future skill change breaks Studio, that's a fast follow-up, not a reason to freeze.
- **Skill prompt size.** The new skill is ~20KB / ~5K tokens. Plus the work item context, issue body, envelope schema, and the agent's tool-call exchanges. A typical drafting session could be 15-30K input tokens. At Sonnet 4 pricing (~$3/M input), each Prepare click costs roughly $0.05-0.10. For an interactive dev tool, that's fine.
- **Latency.** Each Prepare click is a synchronous wait of 10-60s depending on how aggressive the agent is with tool calls. The Studio UI's `preparingPlan` state is the only feedback. If users complain, the next iteration is streaming (out of scope for #167).
- **JSON parsing brittleness.** LLMs occasionally return JSON wrapped in markdown fences, with leading commentary, or with trailing commas. The `parseEnvelope` helper needs to handle the common variants. Don't try to be clever — strip fences if present, trim whitespace, JSON.parse, re-throw with context if it fails. Don't attempt JSON5 / yaml fallbacks; those create more problems than they solve.
- **Test fragility around the harness pattern.** The existing tests use `Object.create(PlansService.prototype)` and manually inject properties. Adding a new injected dependency means updating the harness. Be careful to also inject `drafter` in every test that constructs a harness, otherwise existing tests will fail with "drafter is undefined." A default mock drafter that returns a valid envelope avoids forcing every test to think about drafter behavior.
- **Idempotency of re-prepare on drafting state.** Today the test `is idempotent on drafting → drafting and carries existing scratchpad forward` enforces a specific contract: if you re-prepare while drafting, your scratchpad isn't stomped. Removing this behavior changes the contract — anyone who manually edited a scratchpad will lose it on re-prepare. **This is intentional per the issue** (every Prepare re-drafts). If a user wanted to preserve manual edits, the right primitive is Approve (which transitions to ready and the plan is no longer re-prepareable). Document this in the test deletion commit message.

## Questions / Concerns

### Clarifications Needed

(none — strategic decisions were resolved in the conversation that produced #167; tactical implementation details have clear precedents in SubAgentService)

### Blocked By

(none — fusupo/escapement-pi `ea6cdd1` is already pushed and the DI hotfix `e10632c` is already on develop)

### Assumptions Made

- **Drafter latency 10-60s is acceptable.** No timeout enforcement in the first cut. If the agent runs forever, the underlying pi-coding-agent session has its own implicit timeouts.
- **The skill body fits in a single agent prompt.** ~5K tokens of skill + ~5K tokens of context. Well under Sonnet's context window.
- **`process.cwd()` is the escapement-studio repo root** when the dev server runs. True today (verified — the `npm run dev` invocation runs from the repo root). If this ever changes, the drafter would silently grep the wrong codebase.
- **The github: dep auto-resolves on `npm install`.** Confirmed — `escapement: "github:fusupo/escapement-pi"` re-fetches on `npm install` and the lockfile updates the resolved SHA. If this is wrong, we may need an explicit `npm update escapement` command.
- **Drafter does NOT need to call `gh issue view`.** The issue body is fetched once by PlansService and passed as a prompt parameter. The drafter doesn't need its own GitHub access.

### Decisions Made

- **Always re-draft on every Prepare** (no carry-forward, no manual-edit detection) — confirmed in conversation: *"redo the whole thing with each user action to 'prepare'"*
- **Fail loud on drafter errors** (no fallback to stub) — confirmed in conversation: *"we should be straight"*
- **Refresh predicted_files from envelope.affected_files** — confirmed in conversation: *"the drafter should refine/rewrite them"*
- **Use the bundled escapement skill, not an inlined copy** — confirmed in conversation: *"why can't we basically use those prompts from ~/escapement-pi/skills? isn't escapement-pi already a dependency"*
- **Synchronous, not async with polling** — confirmed: *"sync is fine"*
- **No separate scratchpad-planner pi agent** — content folded into the merged setup-work skill in `ea6cdd1`
- **Don't pin escapement to SHA in package.json** — track main; assume future skill updates are wanted

## Work Log

(filled in during do-work)

---

**Generated:** 2026-04-09
**By:** setup-work skill (Claude Code, applied to escapement-studio)
**Source:** https://github.com/fusupo/escapement-studio/issues/167
