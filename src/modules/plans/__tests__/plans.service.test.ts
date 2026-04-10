import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PlansService } from "../plans.service.js";
import type { PlanDraftEnvelope, PlanResponse } from "../types.js";
import {
  canonicalScratchpadPath,
  ensurePlanDir,
  readPlanMetadata,
  type PlanMetadata,
} from "../../../lib/context-layout.js";
import type { StudioIssueTemplate } from "../../github/studio-issue-template.service.js";
import type { WorkItemRecord, WorkItemState } from "../../graph/types.js";

/**
 * ADR 014 step 4 — PlansService lifecycle tests.
 *
 * Uses the Object.create harness pattern from the execution test suite to
 * bypass NestJS DI. fetchIssueBody (from src/lib/github-cli.ts) is mocked so
 * prepare runs without shelling out to `gh`. PlanDrafterService is also
 * mocked so prepare doesn't actually call out to pi-coding-agent.
 */

vi.mock("../../../lib/github-cli.js", () => ({
  fetchIssueBody: vi.fn(() => "Mocked issue body from fixture."),
}));

interface HarnessWorkItemsService {
  get(id: string): WorkItemRecord;
  update(id: string, patch: Partial<WorkItemRecord>): WorkItemRecord;
}

interface HarnessTemplateService {
  listTemplates(): StudioIssueTemplate[];
}

interface HarnessDrafterService {
  draft(workItem: WorkItemRecord, issueBody: string | null): Promise<PlanDraftEnvelope>;
}

interface Harness {
  service: PlansService;
  workItems: Map<string, WorkItemRecord>;
  updateCalls: Array<{ id: string; patch: Partial<WorkItemRecord> }>;
  templates: StudioIssueTemplate[];
  artifactRoot: string;
  drafter: HarnessDrafterService;
  drafterCalls: Array<{ workItem: WorkItemRecord; issueBody: string | null }>;
}

function makeDraftEnvelope(overrides: Partial<PlanDraftEnvelope> = {}): PlanDraftEnvelope {
  return {
    summary: "Drafted summary text from the mock drafter.",
    acceptance_criteria: ["Drafted criterion A", "Drafted criterion B"],
    implementation_tasks: [
      {
        description: "Drafted task 1",
        files: ["src/foo.ts"],
        rationale: "Foundation step",
        testing: "Unit test the foo helper",
      },
    ],
    affected_files: ["src/foo.ts", "src/bar.ts"],
    questions: ["Drafted open question?"],
    assumptions: ["Drafted assumption"],
    blockers: [],
    technical_notes: {
      architecture: "Drafted architecture notes",
      approach: "Drafted approach notes",
      challenges: "Drafted challenge notes",
    },
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-154",
    name: "Extract prepare-plan from execution launch",
    kind: "issue",
    state: "planned",
    repo: "fusupo/escapement-studio",
    issue_number: 154,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/154",
    scope_hint: "Split plan preparation from execution launch.",
    branch: "154-extract-prepare-plan-from-execution-launch",
    archive_path: null,
    predicted_files: ["src/modules/plans/plans.service.ts"],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeTemplate(kind: "feature" | "bug" | "task", name: string): StudioIssueTemplate {
  return {
    kind,
    path: `.github/ISSUE_TEMPLATE/${kind}.md`,
    name,
    labels: [kind],
    body: `# ${name}\n\n## Summary\n\n## Acceptance Criteria\n`,
  };
}

function makeHarness(
  initial: WorkItemRecord,
  drafterOverride?: HarnessDrafterService,
): Harness {
  const workItems = new Map<string, WorkItemRecord>([[initial.id, initial]]);
  const updateCalls: Array<{ id: string; patch: Partial<WorkItemRecord> }> = [];
  const drafterCalls: Array<{ workItem: WorkItemRecord; issueBody: string | null }> = [];
  const templates: StudioIssueTemplate[] = [makeTemplate("feature", "Feature Request")];
  const artifactRoot = mkdtempSync(join(tmpdir(), "studio-154-"));

  const workItemsService: HarnessWorkItemsService = {
    get(id: string): WorkItemRecord {
      const item = workItems.get(id);
      if (!item) throw new NotFoundException(`Work item not found: ${id}`);
      return item;
    },
    update(id: string, patch: Partial<WorkItemRecord>): WorkItemRecord {
      updateCalls.push({ id, patch });
      const current = workItems.get(id);
      if (!current) throw new NotFoundException(`Work item not found: ${id}`);
      const next: WorkItemRecord = {
        ...current,
        ...patch,
        updated_at: new Date("2026-04-09T00:00:05.000Z").toISOString(),
      };
      workItems.set(id, next);
      return next;
    },
  };
  const templateService: HarnessTemplateService = {
    listTemplates: () => templates,
  };

  // Default drafter: returns a stable envelope and records every call.
  const drafter: HarnessDrafterService = drafterOverride ?? {
    async draft(workItem: WorkItemRecord, issueBody: string | null) {
      drafterCalls.push({ workItem, issueBody });
      return makeDraftEnvelope();
    },
  };

  const service = Object.create(PlansService.prototype) as PlansService;
  (service as unknown as { workItemsService: HarnessWorkItemsService }).workItemsService = workItemsService;
  (service as unknown as { templateService: HarnessTemplateService }).templateService = templateService;
  (service as unknown as { drafter: HarnessDrafterService }).drafter = drafter;
  (service as unknown as { artifactRoot: string }).artifactRoot = artifactRoot;
  (service as unknown as { logger: { log: (m: string) => void } }).logger = { log: () => {} };

  return { service, workItems, updateCalls, templates, artifactRoot, drafter, drafterCalls };
}

function cleanup(h: Harness) {
  rmSync(h.artifactRoot, { recursive: true, force: true });
}

describe("PlansService.prepare", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("calls drafter, transitions planned → drafting, and writes drafted scratchpad", async () => {
    harness = makeHarness(makeWorkItem());

    const result = await harness.service.prepare("studio-154");

    expect(result.work_item_id).toBe("studio-154");
    expect(result.metadata.state).toBe("drafting");
    // Drafter was called once with the work item and the mocked issue body
    expect(harness.drafterCalls).toHaveLength(1);
    expect(harness.drafterCalls[0].workItem.id).toBe("studio-154");
    expect(harness.drafterCalls[0].issueBody).toBe("Mocked issue body from fixture.");

    // Two update calls: predicted_files refresh, then state transition
    expect(harness.updateCalls).toEqual([
      { id: "studio-154", patch: { predicted_files: ["src/foo.ts", "src/bar.ts"] } },
      { id: "studio-154", patch: { state: "drafting" } },
    ]);

    // Scratchpad contains drafted content (not the legacy stub placeholders)
    const canonical = canonicalScratchpadPath(harness.artifactRoot, "studio-154");
    expect(existsSync(canonical)).toBe(true);
    const content = readFileSync(canonical, "utf8");
    expect(content).toContain("# Plan: studio-154");
    expect(content).toContain("Drafted summary text from the mock drafter.");
    expect(content).toContain("Drafted criterion A");
    expect(content).toContain("Drafted task 1");
    expect(content).toContain("Drafted architecture notes");
    // No legacy stub markers
    expect(content).not.toContain("(to be filled in)");
  });

  it("re-drafts on every prepare even when canonical scratchpad already exists", async () => {
    harness = makeHarness(makeWorkItem({ state: "drafting" }));
    ensurePlanDir(harness.artifactRoot, "studio-154");
    const canonical = canonicalScratchpadPath(harness.artifactRoot, "studio-154");
    writeFileSync(canonical, "# Stale prior content — should be overwritten\n", "utf8");

    const result = await harness.service.prepare("studio-154");

    // Drafter called even though we're already drafting
    expect(harness.drafterCalls).toHaveLength(1);
    // Scratchpad overwritten with the new draft
    expect(result.scratchpad_content).not.toContain("Stale prior content");
    expect(result.scratchpad_content).toContain("Drafted summary text from the mock drafter.");
    expect(readFileSync(canonical, "utf8")).toContain("Drafted summary text from the mock drafter.");
    // No state transition (already drafting), but predicted_files refresh still happens
    const stateTransitions = harness.updateCalls.filter((c) => c.patch.state !== undefined);
    expect(stateTransitions).toEqual([]);
    const predictedRefresh = harness.updateCalls.find((c) => c.patch.predicted_files !== undefined);
    expect(predictedRefresh).toBeDefined();
  });

  it("on drafter failure, does not transition state and does not modify existing scratchpad", async () => {
    harness = makeHarness(makeWorkItem(), {
      async draft() {
        throw new Error("simulated drafter explosion");
      },
    });
    // Pre-write a scratchpad we expect to remain untouched
    ensurePlanDir(harness.artifactRoot, "studio-154");
    const canonical = canonicalScratchpadPath(harness.artifactRoot, "studio-154");
    writeFileSync(canonical, "# Untouched\n", "utf8");

    await expect(harness.service.prepare("studio-154")).rejects.toThrow("simulated drafter explosion");

    // No state mutation
    expect(harness.updateCalls).toEqual([]);
    // Work item stayed planned
    expect(harness.workItems.get("studio-154")?.state).toBe("planned");
    // Scratchpad untouched
    expect(readFileSync(canonical, "utf8")).toBe("# Untouched\n");
  });

  it("does not refresh predicted_files when drafter envelope.affected_files is empty", async () => {
    harness = makeHarness(makeWorkItem({ predicted_files: ["src/keep.ts"] }), {
      async draft() {
        return makeDraftEnvelope({ affected_files: [] });
      },
    });

    await harness.service.prepare("studio-154");

    // No predicted_files update — current value preserved
    const predictedUpdate = harness.updateCalls.find((c) => c.patch.predicted_files !== undefined);
    expect(predictedUpdate).toBeUndefined();
    // State transition still happens
    const stateUpdate = harness.updateCalls.find((c) => c.patch.state === "drafting");
    expect(stateUpdate).toBeDefined();
  });

  it("refreshes predicted_files from drafter envelope.affected_files", async () => {
    harness = makeHarness(makeWorkItem({ predicted_files: ["old.ts"] }), {
      async draft() {
        return makeDraftEnvelope({ affected_files: ["new1.ts", "new2.ts"] });
      },
    });

    await harness.service.prepare("studio-154");

    const predictedUpdate = harness.updateCalls.find((c) => c.patch.predicted_files !== undefined);
    expect(predictedUpdate?.patch.predicted_files).toEqual(["new1.ts", "new2.ts"]);
  });

  const rejectedStates: WorkItemState[] = ["in_progress", "open_pr", "merged_pr", "done", "ready", "deferred", "cancelled"];
  for (const state of rejectedStates) {
    it(`rejects prepare when work item is in ${state}`, async () => {
      harness = makeHarness(makeWorkItem({ state }));
      await expect(harness.service.prepare("studio-154")).rejects.toThrow(BadRequestException);
      // Drafter not called
      expect(harness.drafterCalls).toEqual([]);
      // No state mutation on failure
      expect(harness.updateCalls).toEqual([]);
    });
  }

  it("throws NotFoundException when work item does not exist", async () => {
    harness = makeHarness(makeWorkItem());
    await expect(harness.service.prepare("studio-missing")).rejects.toThrow(NotFoundException);
  });
});

describe("PlansService.buildPlanScratchpad / renderPlanScratchpad", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("includes all required canonical sections", () => {
    harness = makeHarness(makeWorkItem());
    const content = harness.service.renderPlanScratchpad(
      makeWorkItem(),
      "Issue body goes here.",
      [makeTemplate("feature", "Feature Request")],
    );

    expect(content).toContain("## Context");
    expect(content).toContain("## Issue Body");
    expect(content).toContain("## Summary");
    expect(content).toContain("## Acceptance Criteria");
    expect(content).toContain("## Implementation Plan");
    expect(content).toContain("## Affected Files");
    expect(content).toContain("## Quality Checks");
    expect(content).toContain("## Questions / Concerns");
    expect(content).toContain("## Studio Issue Templates Available");
    expect(content).toContain("## Work Log");
    expect(content).toContain("## Blockers");
  });

  it("seeds the ## Affected Files section from predicted_files", () => {
    harness = makeHarness(makeWorkItem());
    const content = harness.service.renderPlanScratchpad(
      makeWorkItem({ predicted_files: ["a.ts", "b.ts"] }),
      null,
      [],
    );
    expect(content).toContain("- a.ts");
    expect(content).toContain("- b.ts");
  });

  it("handles missing issue body gracefully", () => {
    harness = makeHarness(makeWorkItem());
    const content = harness.service.renderPlanScratchpad(makeWorkItem(), null, []);
    expect(content).toContain("issue body unavailable");
  });
});

describe("PlansService.extractAffectedFiles", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("extracts bare file paths from a well-formed section", () => {
    harness = makeHarness(makeWorkItem());
    const scratchpad = [
      "# Plan",
      "## Affected Files",
      "",
      "- src/foo.ts",
      "- src/bar.ts",
      "- src/baz.ts",
      "",
      "## Quality Checks",
      "- [ ] tsc",
    ].join("\n");
    expect(harness.service.extractAffectedFiles(scratchpad)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
      "src/baz.ts",
    ]);
  });

  it("strips inline notes separated by — and (", () => {
    harness = makeHarness(makeWorkItem());
    const scratchpad = [
      "## Affected Files",
      "- src/foo.ts — new helper",
      "- src/bar.ts (modify)",
      "- `src/baz.ts`",
      "",
      "## Next",
    ].join("\n");
    expect(harness.service.extractAffectedFiles(scratchpad)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
      "src/baz.ts",
    ]);
  });

  it("skips placeholder parenthetical items", () => {
    harness = makeHarness(makeWorkItem());
    const scratchpad = [
      "## Affected Files",
      "- (none predicted yet — populate during plan review)",
      "- src/real.ts",
      "## End",
    ].join("\n");
    expect(harness.service.extractAffectedFiles(scratchpad)).toEqual(["src/real.ts"]);
  });

  it("dedupes repeated entries", () => {
    harness = makeHarness(makeWorkItem());
    const scratchpad = [
      "## Affected Files",
      "- src/a.ts",
      "- src/a.ts",
      "- src/b.ts",
      "## End",
    ].join("\n");
    expect(harness.service.extractAffectedFiles(scratchpad)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns empty array when section is missing", () => {
    harness = makeHarness(makeWorkItem());
    const scratchpad = "# Plan\n\n## Summary\n\n- not affected files";
    expect(harness.service.extractAffectedFiles(scratchpad)).toEqual([]);
  });

  it("returns empty array when section is empty", () => {
    harness = makeHarness(makeWorkItem());
    const scratchpad = "## Affected Files\n\n<!-- nothing here yet -->\n\n## Next";
    expect(harness.service.extractAffectedFiles(scratchpad)).toEqual([]);
  });
});

describe("PlansService.diffPredictedFiles", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("computes added/removed/unchanged correctly", () => {
    harness = makeHarness(makeWorkItem());
    const diff = harness.service.diffPredictedFiles(["a.ts", "b.ts"], ["b.ts", "c.ts"]);
    expect(diff).toEqual({ added: ["c.ts"], removed: ["a.ts"], unchanged: ["b.ts"] });
  });

  it("returns empty diff for matching lists", () => {
    harness = makeHarness(makeWorkItem());
    const diff = harness.service.diffPredictedFiles(["a.ts"], ["a.ts"]);
    expect(diff).toEqual({ added: [], removed: [], unchanged: ["a.ts"] });
  });
});

describe("PlansService.approve", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  function primeDraft(workItem: WorkItemRecord, affectedFiles: string[]): void {
    // Simulate a prior prepare: ensure plan dir + canonical scratchpad exist
    // and the work item is in drafting state.
    ensurePlanDir(harness.artifactRoot, workItem.id);
    const canonical = canonicalScratchpadPath(harness.artifactRoot, workItem.id);
    const content = [
      "# Plan",
      "## Affected Files",
      ...affectedFiles.map((f) => `- ${f}`),
      "## End",
    ].join("\n");
    writeFileSync(canonical, content, "utf8");
    // Manually mark drafting so approve's precondition passes
    harness.workItems.set(workItem.id, { ...workItem, state: "drafting" });
  }

  it("transitions drafting → ready and records approver metadata", () => {
    harness = makeHarness(makeWorkItem({ state: "drafting" }));
    primeDraft(harness.workItems.get("studio-154")!, ["src/foo.ts"]);
    harness.updateCalls.length = 0; // clear the primeDraft set() noise

    const result = harness.service.approve("studio-154", { approved_by: "alice" });

    expect(result.metadata.state).toBe("ready");
    expect(result.metadata.approved_by).toBe("alice");
    expect(typeof result.metadata.approved_at).toBe("string");
    // The last update call should be the state transition to ready
    const stateUpdate = harness.updateCalls.find((c) => c.patch.state === "ready");
    expect(stateUpdate).toBeDefined();
  });

  it("defaults approved_by to 'local' when dto omits it", () => {
    harness = makeHarness(makeWorkItem({ state: "drafting" }));
    primeDraft(harness.workItems.get("studio-154")!, ["src/foo.ts"]);

    const result = harness.service.approve("studio-154");

    expect(result.metadata.approved_by).toBe("local");
  });

  it("refines predicted_files from ## Affected Files and returns diff", () => {
    const workItem = makeWorkItem({ state: "drafting", predicted_files: ["old.ts", "shared.ts"] });
    harness = makeHarness(workItem);
    primeDraft(workItem, ["shared.ts", "new.ts"]);
    harness.updateCalls.length = 0;

    const result = harness.service.approve("studio-154");

    expect(result.predicted_files_diff).toEqual({
      added: ["new.ts"],
      removed: ["old.ts"],
      unchanged: ["shared.ts"],
    });
    // predicted_files update call came first, then state transition to ready
    const predictedUpdate = harness.updateCalls.find((c) => c.patch.predicted_files !== undefined);
    expect(predictedUpdate?.patch.predicted_files).toEqual(["shared.ts", "new.ts"]);
  });

  it("leaves predicted_files unchanged when ## Affected Files is empty", () => {
    const workItem = makeWorkItem({ state: "drafting", predicted_files: ["keep.ts"] });
    harness = makeHarness(workItem);
    primeDraft(workItem, []); // empty Affected Files
    harness.updateCalls.length = 0;

    const result = harness.service.approve("studio-154");

    expect(result.predicted_files_diff).toEqual({
      added: [],
      removed: ["keep.ts"],
      unchanged: [],
    });
    // No predicted_files update call — current value preserved
    const predictedUpdate = harness.updateCalls.find((c) => c.patch.predicted_files !== undefined);
    expect(predictedUpdate).toBeUndefined();
  });

  const rejectedStates: WorkItemState[] = ["planned", "ready", "in_progress", "open_pr", "merged_pr", "done", "deferred", "cancelled"];
  for (const state of rejectedStates) {
    it(`rejects approve when state is ${state}`, () => {
      harness = makeHarness(makeWorkItem({ state }));
      expect(() => harness.service.approve("studio-154")).toThrow(BadRequestException);
    });
  }

  it("throws NotFoundException when the canonical scratchpad is missing", () => {
    harness = makeHarness(makeWorkItem({ state: "drafting" }));
    // Ensure plan dir exists but not scratchpad
    ensurePlanDir(harness.artifactRoot, "studio-154");
    expect(() => harness.service.approve("studio-154")).toThrow(NotFoundException);
  });
});

describe("PlansService.reopen", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("transitions ready → drafting and clears approver metadata", () => {
    harness = makeHarness(makeWorkItem({ state: "ready" }));
    ensurePlanDir(harness.artifactRoot, "studio-154");
    // Seed metadata with an approved state
    const metadataPath = join(harness.artifactRoot, "plans", "studio_154", "metadata.json");
    const approved: PlanMetadata = {
      plan_id: "studio_154",
      work_item_id: "studio-154",
      created_at: "2026-04-09T00:00:00.000Z",
      updated_at: "2026-04-09T00:00:00.000Z",
      state: "ready",
      scratchpad_path: canonicalScratchpadPath(harness.artifactRoot, "studio-154"),
      approved_at: "2026-04-09T00:00:03.000Z",
      approved_by: "alice",
      run_ids: [],
    };
    writeFileSync(metadataPath, JSON.stringify(approved), "utf8");
    writeFileSync(canonicalScratchpadPath(harness.artifactRoot, "studio-154"), "# Plan", "utf8");

    const result = harness.service.reopen("studio-154");

    expect(result.metadata.state).toBe("drafting");
    expect(result.metadata.approved_at).toBeNull();
    expect(result.metadata.approved_by).toBeNull();
    expect(harness.updateCalls).toEqual([{ id: "studio-154", patch: { state: "drafting" } }]);
  });

  const rejectedStates: WorkItemState[] = ["planned", "drafting", "in_progress", "open_pr", "merged_pr", "done", "deferred", "cancelled"];
  for (const state of rejectedStates) {
    it(`rejects reopen when state is ${state}`, () => {
      harness = makeHarness(makeWorkItem({ state }));
      expect(() => harness.service.reopen("studio-154")).toThrow(BadRequestException);
    });
  }
});

describe("PlansService.get", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("returns metadata + scratchpad for an existing plan", () => {
    harness = makeHarness(makeWorkItem({ state: "drafting" }));
    ensurePlanDir(harness.artifactRoot, "studio-154");
    writeFileSync(
      canonicalScratchpadPath(harness.artifactRoot, "studio-154"),
      "# Plan",
      "utf8",
    );

    const result = harness.service.get("studio-154");

    expect(result.work_item_id).toBe("studio-154");
    expect(result.scratchpad_content).toBe("# Plan");
  });

  it("throws NotFoundException when no plan dir exists", () => {
    harness = makeHarness(makeWorkItem());
    expect(() => harness.service.get("studio-154")).toThrow(NotFoundException);
  });

  it("throws NotFoundException when work item itself does not exist", () => {
    harness = makeHarness(makeWorkItem());
    expect(() => harness.service.get("studio-missing")).toThrow(NotFoundException);
  });
});

describe("PlansService lifecycle (integration)", () => {
  let harness: Harness;

  afterEach(() => {
    if (harness) cleanup(harness);
  });

  it("completes a full planned → drafting → ready → drafting → ready cycle", async () => {
    harness = makeHarness(makeWorkItem({ predicted_files: ["src/foo.ts"] }));

    // 1. prepare
    const afterPrepare: PlanResponse = await harness.service.prepare("studio-154");
    expect(afterPrepare.metadata.state).toBe("drafting");
    expect(harness.workItems.get("studio-154")?.state).toBe("drafting");

    // Inject a custom Affected Files section into the scratchpad so approve
    // can exercise the refinement path.
    const canonical = canonicalScratchpadPath(harness.artifactRoot, "studio-154");
    writeFileSync(
      canonical,
      [
        "# Plan: studio-154",
        "## Affected Files",
        "- src/foo.ts",
        "- src/new.ts",
        "## End",
      ].join("\n"),
      "utf8",
    );

    // 2. approve
    const afterApprove = harness.service.approve("studio-154", { approved_by: "marc" });
    expect(afterApprove.metadata.state).toBe("ready");
    expect(afterApprove.metadata.approved_by).toBe("marc");
    expect(afterApprove.predicted_files_diff?.added).toEqual(["src/new.ts"]);
    expect(harness.workItems.get("studio-154")?.state).toBe("ready");
    expect(harness.workItems.get("studio-154")?.predicted_files).toEqual(["src/foo.ts", "src/new.ts"]);

    // Round-trip metadata via disk
    const diskMetadata = readPlanMetadata(harness.artifactRoot, "studio-154");
    expect(diskMetadata?.state).toBe("ready");
    expect(diskMetadata?.approved_by).toBe("marc");

    // 3. reopen
    const afterReopen = harness.service.reopen("studio-154");
    expect(afterReopen.metadata.state).toBe("drafting");
    expect(afterReopen.metadata.approved_at).toBeNull();
    expect(harness.workItems.get("studio-154")?.state).toBe("drafting");

    // 4. approve again — should succeed on the second pass
    const afterApprove2 = harness.service.approve("studio-154");
    expect(afterApprove2.metadata.state).toBe("ready");
    expect(harness.workItems.get("studio-154")?.state).toBe("ready");
  });
});
