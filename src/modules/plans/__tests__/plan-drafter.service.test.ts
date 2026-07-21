import { describe, expect, it, vi, beforeEach } from "vitest";
import { PlanDrafterService } from "../plan-drafter.service.js";
import type { WorkItemRecord } from "../../graph/types.js";

/**
 * #167 — PlanDrafterService unit tests.
 *
 * Mocks `@earendil-works/pi-coding-agent` so we never actually spawn an LLM
 * session. The drafter is instantiated via `Object.create` to bypass NestJS
 * DI (mirroring the harness pattern in `plans.service.test.ts`).
 */

// ---- pi-coding-agent module mock ------------------------------------------
//
// We expose a `setMockAssistantText` and `setMockBehavior` so individual tests
// can configure how the next createAgentSession call behaves.

let mockAssistantText: string | null = "";
let mockBehavior: "ok" | "throw_in_create" | "throw_in_prompt" | "pending_until_dispose" = "ok";
let mockSessionMessages: unknown[] = [];
let mockDisposeCallCount = 0;
type MockAttempt = {
  assistantText: string | null;
  messages?: unknown[];
  behavior?: "ok" | "throw_in_create" | "throw_in_prompt" | "pending_until_dispose";
};
let mockAttemptQueue: MockAttempt[] = [];
let mockCreateSessionCallCount = 0;

vi.mock("@earendil-works/pi-coding-agent", () => {
  return {
    createAgentSession: vi.fn(async () => {
      mockCreateSessionCallCount++;
      // Queue takes priority when present; lets tests exercise multi-attempt
      // behavior (e.g. first attempt returns a retryable empty, second returns
      // valid JSON). Falls back to the single-shot `mock*` vars otherwise.
      const attempt = mockAttemptQueue.shift();
      const behavior = attempt?.behavior ?? mockBehavior;
      const assistantText = attempt ? attempt.assistantText : mockAssistantText;
      const sessionMessages = attempt?.messages ?? mockSessionMessages;

      if (behavior === "throw_in_create") {
        throw new Error("createAgentSession blew up");
      }
      const session = {
        sessionId: "mock-session",
        messages: sessionMessages,
        async prompt(_text: string) {
          if (behavior === "throw_in_prompt") {
            throw new Error("session.prompt blew up");
          }
          if (behavior === "pending_until_dispose") {
            await new Promise((_, reject) => {
              const poll = () => {
                if (mockDisposeCallCount > 0) {
                  reject(new Error("session cancelled via dispose"));
                  return;
                }
                setTimeout(poll, 0);
              };
              poll();
            });
          }
        },
        getLastAssistantText() {
          return assistantText;
        },
        dispose() {
          mockDisposeCallCount++;
        },
        subscribe(_fn: unknown) {
          return () => {};
        },
      };
      return { session, modelFallbackMessage: null };
    }),
    createReadTool: vi.fn(() => ({ name: "read" })),
    createGrepTool: vi.fn(() => ({ name: "grep" })),
    createBashTool: vi.fn(() => ({ name: "bash" })),
    SessionManager: {
      inMemory: vi.fn(() => ({})),
    },
  };
});

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-167",
    name: "Auto-draft plan scratchpad via pi-coding-agent setup-work skill",
    kind: "issue",
    state: "planned",
    repo: "fusupo/escapement-studio",
    issue_number: 167,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/167",
    scope_hint: "Wire pi-coding-agent into PlansService.prepare",
    branch: "167-auto-draft-plan-scratchpad",
    archive_path: null,
    predicted_files: ["src/modules/plans/plans.service.ts"],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T18:00:00.000Z",
  } as WorkItemRecord & typeof overrides;
}

function makeService(): PlanDrafterService {
  const service = Object.create(PlanDrafterService.prototype) as PlanDrafterService;
  (service as unknown as { settingsService: { getSelectedModel: () => undefined } }).settingsService = {
    getSelectedModel: () => undefined,
  };
  (service as unknown as { logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug: (m: string) => void } }).logger = {
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return service;
}

function validEnvelopeJson(): string {
  return JSON.stringify({
    summary: "Drafted summary",
    acceptance_criteria: ["Crit A", "Crit B"],
    implementation_tasks: [
      {
        description: "Task 1",
        files: ["src/foo.ts"],
        rationale: "Why task 1",
        testing: "How to test task 1",
      },
    ],
    affected_files: ["src/foo.ts", "src/bar.ts"],
    questions: ["Q1?"],
    assumptions: ["Assume A"],
    blockers: [],
    technical_notes: {
      architecture: "arch notes",
      approach: "approach notes",
      challenges: "challenge notes",
    },
  });
}

beforeEach(() => {
  mockAssistantText = validEnvelopeJson();
  mockBehavior = "ok";
  mockSessionMessages = [];
  mockAttemptQueue = [];
  mockCreateSessionCallCount = 0;
  mockDisposeCallCount = 0;
});

describe("PlanDrafterService.loadSkillBody", () => {
  it("resolves and reads the bundled escapement skill file", () => {
    const service = makeService();
    const body = service.loadSkillBody();

    // The 489-line ea6cdd1 skill contains unique markers we can assert on.
    expect(body).toContain("Invocation Modes");
    expect(body).toContain("Programmatic mode");
    expect(body.length).toBeGreaterThan(10000);
  });
});

describe("PlanDrafterService.buildDraftPrompt", () => {
  it("embeds the skill body verbatim", () => {
    const service = makeService();
    const skillBody = "## TEST SKILL BODY MARKER ##";
    const prompt = service.buildDraftPrompt({
      skillBody,
      workItem: makeWorkItem(),
      issueBody: "issue body text",
    });
    expect(prompt).toContain("## TEST SKILL BODY MARKER ##");
  });

  it("embeds work item id, name, repo, and issue body", () => {
    const service = makeService();
    const prompt = service.buildDraftPrompt({
      skillBody: "(skill)",
      workItem: makeWorkItem(),
      issueBody: "Issue body content here.",
    });
    expect(prompt).toContain("studio-167");
    expect(prompt).toContain("Auto-draft plan scratchpad via pi-coding-agent setup-work skill");
    expect(prompt).toContain("fusupo/escapement-studio");
    expect(prompt).toContain("Issue body content here.");
  });

  it("declares programmatic mode and demands a JSON-only final message", () => {
    const service = makeService();
    const prompt = service.buildDraftPrompt({
      skillBody: "(skill)",
      workItem: makeWorkItem(),
      issueBody: null,
    });
    expect(prompt).toContain("PROGRAMMATIC MODE");
    expect(prompt).toContain("JSON envelope schema");
    expect(prompt).toContain("first character of your final message is `{`");
  });

  it("substitutes a placeholder when issue body is null", () => {
    const service = makeService();
    const prompt = service.buildDraftPrompt({
      skillBody: "(skill)",
      workItem: makeWorkItem(),
      issueBody: null,
    });
    expect(prompt).toContain("issue body unavailable");
  });
});

describe("PlanDrafterService.parseEnvelope", () => {
  it("parses valid JSON into a typed envelope", () => {
    const service = makeService();
    const result = service.parseEnvelope(validEnvelopeJson());

    expect(result.summary).toBe("Drafted summary");
    expect(result.acceptance_criteria).toEqual(["Crit A", "Crit B"]);
    expect(result.implementation_tasks).toHaveLength(1);
    expect(result.implementation_tasks[0].description).toBe("Task 1");
    expect(result.affected_files).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(result.technical_notes.architecture).toBe("arch notes");
  });

  it("strips ```json ... ``` markdown fences", () => {
    const service = makeService();
    const fenced = "```json\n" + validEnvelopeJson() + "\n```";
    const result = service.parseEnvelope(fenced);
    expect(result.summary).toBe("Drafted summary");
  });

  it("strips bare ``` ... ``` markdown fences", () => {
    const service = makeService();
    const fenced = "```\n" + validEnvelopeJson() + "\n```";
    const result = service.parseEnvelope(fenced);
    expect(result.summary).toBe("Drafted summary");
  });

  it("extracts JSON when the agent prefixes it with commentary (real-world case)", () => {
    // This is the exact failure mode observed in the first manual smoke run
    // on studio-138 — the agent prefixed the JSON with a sentence like
    // "Now I have enough to draft the plan. Producing the JSON envelope."
    const service = makeService();
    const wrapped = "Now I have enough to draft the plan. Producing the JSON envelope.\n\n" + validEnvelopeJson();
    const result = service.parseEnvelope(wrapped);
    expect(result.summary).toBe("Drafted summary");
  });

  it("extracts JSON when the agent appends commentary after it", () => {
    const service = makeService();
    const wrapped = validEnvelopeJson() + "\n\nThat is the plan!";
    const result = service.parseEnvelope(wrapped);
    expect(result.summary).toBe("Drafted summary");
  });

  it("extracts JSON when wrapped in both preamble and postamble", () => {
    const service = makeService();
    const wrapped =
      "Here is the drafted plan:\n\n" + validEnvelopeJson() + "\n\nLet me know if you have questions.";
    const result = service.parseEnvelope(wrapped);
    expect(result.summary).toBe("Drafted summary");
  });

  it("skips brace-balanced preamble noise that is not valid JSON (studio-179 regression)", () => {
    // Real failure mode from studio-179: agent was grepping Svelte files for
    // the Settings model selector and its preamble copied `{selectedModelKey}`
    // out of a template. The old first-balanced-span extractor grabbed that
    // 17-char span as the "envelope" and JSON.parse exploded on the unquoted
    // property name. The new enumerator should skip it and find the real
    // envelope that follows.
    const service = makeService();
    const wrapped =
      "I looked at {selectedModelKey} in Settings.svelte and the adjacent " +
      "{foo_bar} interpolation, then drafted the plan:\n\n" +
      validEnvelopeJson();
    const result = service.parseEnvelope(wrapped);
    expect(result.summary).toBe("Drafted summary");
  });

  it("skips a JS code fragment in preamble that is brace-balanced but not JSON", () => {
    const service = makeService();
    const wrapped =
      "I found `const x = {foo: 1, bar: {baz: 2}};` in the file, then drafted:\n\n" +
      validEnvelopeJson();
    const result = service.parseEnvelope(wrapped);
    expect(result.summary).toBe("Drafted summary");
  });

  it("handles braces inside JSON string values without confusion", () => {
    // String values containing `{` and `}` should not throw off the
    // brace-depth tracker.
    const service = makeService();
    const tricky = JSON.stringify({
      summary: "This summary contains { and } characters in it { tricky }",
      acceptance_criteria: ["Use { template literals }"],
      implementation_tasks: [
        {
          description: "Handle { braces } in code",
          files: ["src/{foo,bar}.ts"],
          rationale: "Why { braces } are tricky",
          testing: "Test { brace } handling",
        },
      ],
      affected_files: ["src/foo.ts"],
      questions: [],
      assumptions: [],
      blockers: [],
      technical_notes: { architecture: "{}", approach: "{}", challenges: "{}" },
    });
    const wrapped = "Preamble: " + tricky + " postamble";
    const result = service.parseEnvelope(wrapped);
    expect(result.summary).toContain("{ tricky }");
    expect(result.implementation_tasks[0].description).toContain("{ braces }");
  });

  it("throws on malformed JSON", () => {
    const service = makeService();
    expect(() => service.parseEnvelope("not actual json {")).toThrow(/not valid JSON/);
  });

  it("throws when the response is a JSON array (not an object)", () => {
    const service = makeService();
    expect(() => service.parseEnvelope("[]")).toThrow(/not a JSON object/);
  });

  it("throws when summary is missing", () => {
    const service = makeService();
    const malformed = JSON.stringify({
      acceptance_criteria: [],
      implementation_tasks: [],
      affected_files: [],
      questions: [],
      assumptions: [],
      blockers: [],
      technical_notes: { architecture: "", approach: "", challenges: "" },
    });
    expect(() => service.parseEnvelope(malformed)).toThrow(/missing or non-string field 'summary'/);
  });

  it("throws when implementation_tasks contains a non-object", () => {
    const service = makeService();
    const malformed = JSON.stringify({
      summary: "x",
      acceptance_criteria: [],
      implementation_tasks: ["should be an object, not a string"],
      affected_files: [],
      questions: [],
      assumptions: [],
      blockers: [],
      technical_notes: { architecture: "", approach: "", challenges: "" },
    });
    expect(() => service.parseEnvelope(malformed)).toThrow(/implementation_tasks\[0\] is not an object/);
  });

  it("throws when technical_notes is missing", () => {
    const service = makeService();
    const malformed = JSON.stringify({
      summary: "x",
      acceptance_criteria: [],
      implementation_tasks: [],
      affected_files: [],
      questions: [],
      assumptions: [],
      blockers: [],
    });
    expect(() => service.parseEnvelope(malformed)).toThrow(/technical_notes/);
  });
});

describe("PlanDrafterService.startDraft / draft (integration with mocked pi-coding-agent)", () => {
  it("returns a parsed envelope on a successful agent run", async () => {
    const service = makeService();
    const result = await service.draft(makeWorkItem(), "issue body");

    expect(result.summary).toBe("Drafted summary");
    expect(result.implementation_tasks).toHaveLength(1);
    expect(result.affected_files).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("throws when the agent returns an empty assistant message", async () => {
    mockAssistantText = "";
    const service = makeService();
    await expect(service.draft(makeWorkItem(), null)).rejects.toThrow(/empty assistant message/);
  });

  it("throws when the agent returns malformed JSON", async () => {
    mockAssistantText = "this is not json at all";
    const service = makeService();
    await expect(service.draft(makeWorkItem(), null)).rejects.toThrow(/not valid JSON/);
  });

  it("propagates createAgentSession errors", async () => {
    mockBehavior = "throw_in_create";
    const service = makeService();
    await expect(service.draft(makeWorkItem(), null)).rejects.toThrow(/createAgentSession blew up/);
  });

  it("propagates session.prompt errors", async () => {
    mockBehavior = "throw_in_prompt";
    const service = makeService();
    await expect(service.draft(makeWorkItem(), null)).rejects.toThrow(/session.prompt blew up/);
  });

  // #85 regression — the model emitted a tool_use block with malformed JSON
  // arguments, partial-json rejected it, pi-ai stamped stopReason="error",
  // the session ended with a broken assistant turn as the last message,
  // and our helper saw empty text. draft() should retry with a fresh
  // session on this specific failure mode.
  it("retries once when the first session dies mid-stream with stopReason=error", async () => {
    mockAttemptQueue = [
      {
        assistantText: "",
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage:
              "Expected double-quoted property name in JSON at position 106",
            content: [{ type: "toolCall", name: "Grep" }],
          },
        ],
      },
      {
        assistantText: validEnvelopeJson(),
        messages: [],
      },
    ];
    const service = makeService();
    const result = await service.draft(makeWorkItem(), "issue body");
    expect(result.summary).toBe("Drafted summary");
    expect(mockCreateSessionCallCount).toBe(2);
  });

  it("does NOT retry when empty text comes from a non-error stop reason", async () => {
    // stopReason="end_turn" with no text blocks is probably a real bug,
    // not a flake, so fail fast with the diagnostic.
    mockAttemptQueue = [
      {
        assistantText: "",
        messages: [
          {
            role: "assistant",
            stopReason: "end_turn",
            content: [{ type: "toolCall", name: "Read" }],
          },
        ],
      },
      // Queue includes a would-be-successful attempt — it should NOT be consumed.
      { assistantText: validEnvelopeJson(), messages: [] },
    ];
    const service = makeService();
    await expect(service.draft(makeWorkItem(), null)).rejects.toThrow(/empty assistant message/);
    expect(mockCreateSessionCallCount).toBe(1);
  });

  it("rethrows the diagnostic error after exhausting retries", async () => {
    // Two consecutive retryable failures — draft() should give up after
    // MAX_DRAFT_ATTEMPTS and throw the last diagnostic error.
    const retryableAttempt: MockAttempt = {
      assistantText: "",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "parse error",
          content: [{ type: "toolCall", name: "Grep" }],
        },
      ],
    };
    mockAttemptQueue = [retryableAttempt, retryableAttempt];
    const service = makeService();
    await expect(service.draft(makeWorkItem(), null)).rejects.toThrow(/empty assistant message/);
    expect(mockCreateSessionCallCount).toBe(2);
  });

  it("actively cancels the underlying session and rejects the handle", async () => {
    mockBehavior = "pending_until_dispose";
    const service = makeService();

    const handle = service.startDraft(makeWorkItem(), null);
    handle.cancel();

    await expect(handle.completion).rejects.toThrow(/draft cancelled/);
    expect(mockDisposeCallCount).toBeGreaterThan(0);
  });
});
