import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../execution.service.js";
import { RunRefinementService } from "../run-refinement.service.js";
import { ScratchpadService } from "../scratchpad.service.js";
import type { ExecutionDispatchNodePreview, ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

function makeRun(root: string, overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_refine",
    run_type: "execution",
    work_item_id: "studio-118",
    work_item_name: "Approval-gated issue updates",
    status: "preparing",
    phase: "preparing",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: "https://github.com/fusupo/escapement-studio/issues/118",
    branch: "studio-118-branch",
    base_ref: "develop",
    worktree_path: join(root, "worktree"),
    artifact_dir: join(root, "runs", "exec_refine"),
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function makeWorkItem(): WorkItemRecord {
  return {
    id: "studio-118",
    name: "Approval-gated issue updates",
    kind: "issue",
    state: "in_progress",
    repo: "fusupo/escapement-studio",
    issue_number: 118,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/118",
    scope_hint: "Keep managed blocks safe.",
    branch: "studio-118-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-07-20T00:00:00.000Z",
  };
}

function makeNode(run: ExecutionRunRecord): ExecutionDispatchNodePreview {
  return {
    id: run.work_item_id,
    name: run.work_item_name,
    repo: run.repo ?? null,
    branch: run.branch,
    issue_url: run.issue_url ?? undefined,
    scope_hint: "Keep managed blocks safe.",
    default_base_ref: run.base_ref,
    files_owned: ["src/modules/github/issues.ts"],
    files_shared: [],
    files_forbidden: [],
    worktree_path: run.worktree_path,
    safety_checks: [],
    can_launch: true,
    issue_backed: true,
    launch_unavailable_code: null,
    launch_unavailable_reason: null,
  };
}

function makeRunStore(initialRun: ExecutionRunRecord) {
  let current = initialRun;
  return {
    get current() { return current; },
    updateRun: vi.fn((_runId: string, patch: Partial<ExecutionRunRecord>) => {
      current = { ...current, ...patch, updated_at: "2026-07-20T00:01:00.000Z" };
      return current;
    }),
    getRun: vi.fn(() => current),
    appendEvent: vi.fn(),
    emitRun: vi.fn(),
  };
}

describe("worktree execution refinement", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "execution-refinement-"));
    mkdirSync(join(root, "worktree"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ends the setup session and persists structured questions before coding", async () => {
    const run = makeRun(root);
    const scratchpadPath = join(run.worktree_path, "SCRATCHPAD_studio_118.md");
    writeFileSync(scratchpadPath, "initial approved plan", "utf8");
    const runStore = makeRunStore(run);
    const unsubscribe = vi.fn();
    const session = {
      sessionId: "session_refine",
      subscribe: vi.fn(() => unsubscribe),
      prompt: vi.fn(async () => {
        writeFileSync(scratchpadPath, [
          "# Refined plan",
          "### Clarifications Needed",
          "- Should updates preserve text outside the managed block?",
          "  ```execution-refinement",
          "  {\"options\":[{\"id\":\"preserve\",\"label\":\"Preserve text\",\"description\":\"Recommended safe path\"},{\"id\":\"replace\",\"label\":\"Replace all text\"}],\"recommended_option_id\":\"preserve\",\"allow_other\":true}",
          "  ```",
          "## Blockers",
          "- The fixture format is ambiguous.",
        ].join("\n"), "utf8");
      }),
      dispose: vi.fn(),
    };
    const interaction = {
      createSession: vi.fn(async () => ({ session, modelFallbackMessage: null })),
      registerSession: vi.fn(),
      disposeSession: vi.fn(),
      handleSessionEvent: vi.fn(),
      pushActivity: vi.fn(),
    };
    const scratchpad = Object.create(ScratchpadService.prototype) as ScratchpadService;
    (scratchpad as any).syncScratchpadToCanonical = vi.fn();
    (scratchpad as any).emitChecklistIfChanged = vi.fn();
    const service = new RunRefinementService(runStore as any, scratchpad, interaction as any);

    const result = await service.refine(run, {
      node: makeNode(run),
      workItem: makeWorkItem(),
      scratchpadPath,
      issueBody: "Issue body",
      projectContext: null,
    });

    expect(result).toMatchObject({
      status: "disambiguating",
      phase: "awaiting_confirmation",
      session_id: undefined,
      refinement: {
        status: "awaiting_confirmation",
        items: [
          {
            id: "question-1",
            kind: "question",
            prompt: "Should updates preserve text outside the managed block?",
            options: [
              { id: "preserve", label: "Preserve text", description: "Recommended safe path" },
              { id: "replace", label: "Replace all text" },
            ],
            recommended_option_id: "preserve",
            allow_other: true,
            selected_option_id: null,
            response: null,
          },
          {
            id: "blocker-1",
            kind: "blocker",
            prompt: "The fixture format is ambiguous.",
            selected_option_id: null,
            response: null,
          },
        ],
      },
    });
    expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("do not code yet"));
    expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("```execution-refinement"));
    expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining('"action": "cancel_execution"'));
    expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("Invalid metadata degrades"));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(interaction.disposeSession).toHaveBeenCalledWith(run.run_id);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("fails closed when the refinement agent drops required scratchpad sections", async () => {
    const run = makeRun(root);
    const scratchpadPath = join(run.worktree_path, "SCRATCHPAD_studio_118.md");
    writeFileSync(scratchpadPath, "# Refined plan without the contract", "utf8");
    const runStore = makeRunStore(run);
    const session = {
      sessionId: "session_bad_refine",
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const interaction = {
      createSession: vi.fn(async () => ({ session, modelFallbackMessage: null })),
      registerSession: vi.fn(),
      disposeSession: vi.fn(),
      handleSessionEvent: vi.fn(),
      pushActivity: vi.fn(),
    };
    const scratchpad = Object.create(ScratchpadService.prototype) as ScratchpadService;
    (scratchpad as any).syncScratchpadToCanonical = vi.fn();
    (scratchpad as any).emitChecklistIfChanged = vi.fn();
    const service = new RunRefinementService(runStore as any, scratchpad, interaction as any);

    await expect(service.refine(run, {
      node: makeNode(run),
      workItem: makeWorkItem(),
      scratchpadPath,
      issueBody: null,
      projectContext: null,
    })).rejects.toThrow(/refinement_contract_invalid/);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(scratchpad.syncScratchpadToCanonical).not.toHaveBeenCalled();
  });

  it("accepts equivalent H2/H3 refinement section depths", async () => {
    const run = makeRun(root);
    const scratchpadPath = join(run.worktree_path, "SCRATCHPAD_studio_118.md");
    writeFileSync(scratchpadPath, [
      "# Refined plan",
      "",
      "## Clarifications Needed",
      "",
      "- Which API?",
      "",
      "### Blockers",
      "",
      "_(none)_",
    ].join("\n"), "utf8");
    const runStore = makeRunStore(run);
    const session = {
      sessionId: "session_heading_depth",
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const interaction = {
      createSession: vi.fn(async () => ({ session, modelFallbackMessage: null })),
      registerSession: vi.fn(),
      disposeSession: vi.fn(),
      handleSessionEvent: vi.fn(),
      pushActivity: vi.fn(),
    };
    const scratchpad = Object.create(ScratchpadService.prototype) as ScratchpadService;
    (scratchpad as any).syncScratchpadToCanonical = vi.fn();
    (scratchpad as any).emitChecklistIfChanged = vi.fn();
    const service = new RunRefinementService(runStore as any, scratchpad, interaction as any);

    const result = await service.refine(run, {
      node: makeNode(run),
      workItem: makeWorkItem(),
      scratchpadPath,
      issueBody: null,
      projectContext: null,
    });

    expect(result.status).toBe("disambiguating");
    expect(result.refinement?.items).toEqual([
      expect.objectContaining({ kind: "question", prompt: "Which API?" }),
    ]);
  });
});

describe("durable execution confirmation", () => {
  it("requires answers or explicit acceptance, then persists responses before queuing coding", async () => {
    const initial = makeRun("/tmp", {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [
          { id: "question-1", kind: "question", prompt: "Which API?", response: null },
          { id: "blocker-1", kind: "blocker", prompt: "Fixture unclear", response: null },
        ],
        started_at: "2026-07-20T00:00:00.000Z",
        refined_at: "2026-07-20T00:01:00.000Z",
      },
    });
    const runStore = makeRunStore(initial);
    const service = Object.create(ExecutionService.prototype) as any;
    service.runStore = runStore;
    service.now = () => "2026-07-20T00:02:00.000Z";
    service.runInteractionService = { pushActivity: vi.fn() };
    service.continueRunAfterConfirmation = vi.fn(async () => {});
    service.failRun = vi.fn(async () => {});

    const incomplete = await service.resolveDisambiguation({
      run_id: initial.run_id,
      responses: [{ item_id: "question-1", response: "Use the issue service." }],
    });
    expect(incomplete).toMatchObject({ resolved: false, error: expect.stringContaining("Answer all") });
    expect(service.continueRunAfterConfirmation).not.toHaveBeenCalled();

    const confirmed = await service.resolveDisambiguation({
      run_id: initial.run_id,
      responses: [{ item_id: "question-1", response: "Use the issue service." }],
      additional_context: "Preserve unmanaged text.",
      confirm_unresolved: true,
    });

    expect(confirmed.resolved).toBe(true);
    expect(runStore.current).toMatchObject({
      status: "queued",
      phase: "coding",
      refinement: {
        status: "confirmed",
        confirmed_at: "2026-07-20T00:02:00.000Z",
        confirmed_with_unresolved: true,
        additional_context: "Preserve unmanaged text.",
        items: [
          { id: "question-1", response: "Use the issue service." },
          { id: "blocker-1", response: null },
        ],
      },
    });
    expect(service.continueRunAfterConfirmation).toHaveBeenCalledOnce();
  });

  it("validates listed/custom answers and ignores tampered listed meaning", async () => {
    const initial = makeRun("/tmp", {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [
          {
            id: "question-1",
            kind: "question",
            prompt: "Which API?",
            options: [
              { id: "safe", label: "Safe API", description: "Recommended" },
              { id: "fast", label: "Fast API" },
            ],
            recommended_option_id: "safe",
            response: null,
          },
          {
            id: "blocker-1",
            kind: "blocker",
            prompt: "Any constraint?",
            options: [{ id: "none", label: "No constraint" }, { id: "revise", label: "Revise" }],
            allow_other: true,
            response: null,
          },
        ],
        started_at: "2026-07-20T00:00:00.000Z",
      },
    });
    const runStore = makeRunStore(initial);
    const service = Object.create(ExecutionService.prototype) as any;
    Object.assign(service, {
      runStore,
      runInteractionService: { pushActivity: vi.fn() },
      continueRunAfterConfirmation: vi.fn(async () => {}),
      failRun: vi.fn(),
      now: () => "2026-07-20T00:02:00.000Z",
    });

    const result = await service.resolveDisambiguation({
      run_id: initial.run_id,
      responses: [
        { item_id: "question-1", selected_option_id: "safe", response: "tampered" },
        { item_id: "blocker-1", response: "  Preserve compatibility  " },
      ],
    });

    expect(result.resolved).toBe(true);
    expect(runStore.current.refinement?.items).toMatchObject([
      { selected_option_id: "safe", response: "Safe API — Recommended" },
      { selected_option_id: null, response: "Preserve compatibility" },
    ]);
  });

  it.each([
    ["duplicate item", [
      { item_id: "question-1", response: "one" },
      { item_id: "question-1", response: "two" },
    ], /Duplicate/],
    ["unknown item", [{ item_id: "missing", response: "answer" }], /Unknown refinement item/],
    ["blank item ID", [{ item_id: " ", response: "answer" }], /nonblank item_id/],
    ["non-object entry", [null], /must be an object/],
    ["unknown option", [{ item_id: "question-1", selected_option_id: "missing" }], /Unknown option/],
    ["blank Other", [{ item_id: "question-1", response: " " }], /does not allow a custom response/],
  ])("rejects %s without mutating persisted state", async (_name, responses, error) => {
    const initial = makeRun("/tmp", {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [{
          id: "question-1",
          kind: "question",
          prompt: "Choose",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          response: null,
        }],
        started_at: "2026-07-20T00:00:00.000Z",
      },
    });
    const runStore = makeRunStore(initial);
    const service = Object.create(ExecutionService.prototype) as any;
    Object.assign(service, { runStore, now: vi.fn() });
    const result = await service.resolveDisambiguation({ run_id: initial.run_id, responses });
    expect(result).toMatchObject({ resolved: false, error: expect.stringMatching(error as RegExp) });
    expect(runStore.updateRun).not.toHaveBeenCalled();
  });

  it("abandons on an explicit cancellation action and returns the work item to ready", async () => {
    const initial = makeRun("/tmp", {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [
          { id: "question-1", kind: "question", prompt: "Still unresolved", response: null },
          {
            id: "blocker-1",
            kind: "blocker",
            prompt: "Proceed?",
            options: [
              { id: "revise", label: "Revise" },
              { id: "cancel", label: "Cancel execution", action: "cancel_execution" },
            ],
            response: null,
          },
        ],
        started_at: "2026-07-20T00:00:00.000Z",
      },
    });
    const runStore = makeRunStore(initial);
    const service = Object.create(ExecutionService.prototype) as any;
    Object.assign(service, {
      runStore,
      runInteractionService: { pushActivity: vi.fn() },
      transitionInProgressToReady: vi.fn(async () => makeWorkItem()),
      continueRunAfterConfirmation: vi.fn(),
      now: () => "2026-07-20T00:02:00.000Z",
    });

    const result = await service.resolveDisambiguation({
      run_id: initial.run_id,
      responses: [{ item_id: "blocker-1", selected_option_id: "cancel", response: "ignored" }],
    });

    expect(result).toMatchObject({ resolved: true, run: { status: "error", phase: "failed" } });
    expect(service.transitionInProgressToReady).toHaveBeenCalledWith(initial.work_item_id);
    expect(runStore.current.progress_message).toMatch(/abandoned/);
    expect(runStore.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "execution_abandoned" }));
    expect(service.continueRunAfterConfirmation).not.toHaveBeenCalled();
  });

  it("leaves the run awaiting confirmation when cancellation cannot return the work item to ready", async () => {
    const initial = makeRun("/tmp", {
      status: "disambiguating",
      phase: "awaiting_confirmation",
      refinement: {
        status: "awaiting_confirmation",
        items: [{
          id: "blocker-1",
          kind: "blocker",
          prompt: "Proceed?",
          options: [
            { id: "go", label: "Proceed" },
            { id: "cancel", label: "Cancel", action: "cancel_execution" },
          ],
          response: null,
        }],
        started_at: "2026-07-20T00:00:00.000Z",
      },
    });
    const runStore = makeRunStore(initial);
    const service = Object.create(ExecutionService.prototype) as any;
    Object.assign(service, {
      runStore,
      transitionInProgressToReady: vi.fn(async () => { throw new Error("wrong state"); }),
      now: () => "2026-07-20T00:02:00.000Z",
    });
    const result = await service.resolveDisambiguation({
      run_id: initial.run_id,
      responses: [{ item_id: "blocker-1", selected_option_id: "cancel" }],
    });
    expect(result).toMatchObject({ resolved: false, error: expect.stringContaining("wrong state") });
    expect(runStore.updateRun).not.toHaveBeenCalled();
  });

  it("builds explicit listed, Other, and legacy resolution context", () => {
    const run = makeRun("/tmp", {
      refinement: {
        status: "confirmed",
        items: [
          {
            id: "question-1",
            kind: "question",
            prompt: "Which API?",
            options: [{ id: "safe", label: "Safe API", description: "Stable" }, { id: "fast", label: "Fast" }],
            selected_option_id: "safe",
            response: "Safe API — Stable",
          },
          {
            id: "blocker-1",
            kind: "blocker",
            prompt: "Constraint?",
            options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
            allow_other: true,
            selected_option_id: null,
            response: "Custom constraint",
          },
          { id: "question-2", kind: "question", prompt: "Notes?", response: "Legacy note" },
        ],
        started_at: "2026-07-20T00:00:00.000Z",
      },
    });
    const service = Object.create(RunRefinementService.prototype) as RunRefinementService;
    const resolution = service.buildResolutionPrompt(run)!;
    expect(resolution).toContain("Selected option: safe — Safe API");
    expect(resolution).toContain("Description: Stable");
    expect(resolution).toContain("Other (free text): Custom constraint");
    expect(resolution).toContain("Free text: Legacy note");
  });
});
