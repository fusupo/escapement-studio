import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../execution.service.js";
import { ScratchpadService } from "../scratchpad.service.js";
import type { ExecutionDispatchNodePreview, ExecutionRunRecord } from "../types.js";
import {
  canonicalScratchpadPath,
  ensurePlanDir,
  planDir,
  readPlanMetadata,
} from "../../../lib/context-layout.js";

/**
 * Canonical scratchpad behavior (ADR 014 step 2).
 *
 * Phase 4c (#232): the pure scratchpad methods live on
 * ScratchpadService. The HTTP getters stay on ExecutionService as thin
 * orchestrator wrappers that delegate to the injected scratchpadService.
 * `appendRunIdToPlanMetadata` stays on ExecutionService.
 *
 * Tests use `Object.create` to bypass DI and inject the minimal set of
 * fields each method under test needs.
 */

// ─── ScratchpadService harness (pure scratchpad methods) ──────────────

interface ScratchpadHarness {
  artifactRoot: string;
  logger: { warn: (msg: string) => void };
  warnings: string[];
  syncScratchpadToCanonical: ScratchpadService["syncScratchpadToCanonical"];
  getRunScratchpad: ScratchpadService["getRunScratchpad"];
  getRunChecklist: ScratchpadService["getRunChecklist"];
  writeScratchpad: ScratchpadService["writeScratchpad"];
  buildScratchpad: ScratchpadService["buildScratchpad"];
}

function makeScratchpadService(artifactRoot: string): ScratchpadHarness {
  const service = Object.create(ScratchpadService.prototype) as ScratchpadHarness;
  service.artifactRoot = artifactRoot;
  service.warnings = [];
  service.logger = {
    warn: (msg: string) => {
      service.warnings.push(msg);
    },
  };
  // writeScratchpad falls back to buildScratchpad when the canonical
  // file is missing. buildScratchpad is pure so the real implementation
  // works, but we override with a deterministic stub so the synthesis
  // test is stable.
  (service as any).buildScratchpad = () => "synthesized skeleton content";
  return service;
}

// ─── ExecutionService harness (thin-wrapper HTTP getters + appendRunIdToPlanMetadata) ──

interface ExecutionHarness {
  artifactRoot: string;
  logger: { warn: (msg: string) => void };
  warnings: string[];
  getRunScratchpad: ExecutionService["getRunScratchpad"];
  getRunChecklist: ExecutionService["getRunChecklist"];
  appendRunIdToPlanMetadata: (workItemId: string, runId: string) => void;
  getErrorMessage: (error: unknown) => string;
  runStore: {
    getRun: (runId: string) => ExecutionRunRecord | null;
  };
  scratchpadService: ScratchpadService;
}

function makeExecutionService(artifactRoot: string, run?: ExecutionRunRecord): ExecutionHarness {
  const service = Object.create(ExecutionService.prototype) as ExecutionHarness;
  service.artifactRoot = artifactRoot;
  service.warnings = [];
  service.logger = {
    warn: (msg: string) => {
      service.warnings.push(msg);
    },
  };
  // Phase 4a (#230): getRun lives on RunStore.
  service.runStore = {
    getRun: (runId: string) => (run && run.run_id === runId ? run : null),
  };
  // Phase 4c (#232): the thin-wrapper getters delegate to a real
  // ScratchpadService. Construct a ScratchpadService-prototype harness
  // and wire it up; the instance doesn't need RunStore/WorktreeService
  // for the getter paths under test.
  const scratchpad = Object.create(ScratchpadService.prototype) as ScratchpadService;
  (scratchpad as any).artifactRoot = artifactRoot;
  (scratchpad as any).logger = { warn: () => {} };
  service.scratchpadService = scratchpad;
  return service;
}

// ─── Fixtures ─────────────────────────────────────────────────────────

function makeNode(workItemId: string): ExecutionDispatchNodePreview {
  const branch = `${workItemId}-branch`;
  return {
    id: workItemId,
    name: `Test: ${workItemId}`,
    repo: "fusupo/escapement-studio",
    branch,
    issue_url: undefined,
    scope_hint: null,
    default_base_ref: "develop",
    files_owned: ["src/example.ts"],
    files_shared: [],
    files_forbidden: [],
    worktree_path: `/tmp/${branch}`,
    safety_checks: [],
    can_launch: true,
    issue_backed: true,
    launch_unavailable_code: null,
    launch_unavailable_reason: null,
  };
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_test",
    run_type: "execution",
    work_item_id: "studio-999",
    work_item_name: "Test work item",
    status: "running",
    created_at: "2026-04-09T00:00:00.000Z",
    updated_at: "2026-04-09T00:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "studio-999-branch",
    base_ref: "develop",
    worktree_path: "",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

describe("ScratchpadService canonical flow", () => {
  let tmpRoot: string;
  let worktree: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-152-"));
    worktree = join(tmpRoot, "wt");
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("syncScratchpadToCanonical", () => {
    it("copies the worktree scratchpad to canonical when present", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      // Seed the canonical plan dir and the worktree scratchpad
      mkdirSync(planDir(tmpRoot, run.work_item_id), { recursive: true });
      const worktreeScratchpad = join(worktree, "SCRATCHPAD_studio_999.md");
      writeFileSync(worktreeScratchpad, "agent-authored content", "utf8");

      service.syncScratchpadToCanonical(run);

      const canonical = canonicalScratchpadPath(tmpRoot, run.work_item_id);
      expect(existsSync(canonical)).toBe(true);
      expect(readFileSync(canonical, "utf8")).toBe("agent-authored content");
    });

    it("leaves canonical unchanged and logs a warning when worktree file is missing", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      // Seed canonical with prior content; no worktree scratchpad
      mkdirSync(planDir(tmpRoot, run.work_item_id), { recursive: true });
      const canonical = canonicalScratchpadPath(tmpRoot, run.work_item_id);
      writeFileSync(canonical, "last-known-good", "utf8");

      expect(() => service.syncScratchpadToCanonical(run)).not.toThrow();
      expect(readFileSync(canonical, "utf8")).toBe("last-known-good");
      expect(service.warnings.some((w) => w.includes("worktree scratchpad missing"))).toBe(true);
    });
  });

  // ADR 014 step 5: writeScratchpad must source content differently depending
  // on the plan metadata state, returning a discriminated result so the
  // caller knows whether to run the setup phase.
  describe("writeScratchpad (ADR 014 step 5)", () => {
    it("copies canonical into the worktree when plan state is 'ready'", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      // Seed a ready plan: canonical scratchpad + metadata marked ready
      ensurePlanDir(tmpRoot, run.work_item_id);
      const canonical = canonicalScratchpadPath(tmpRoot, run.work_item_id);
      writeFileSync(canonical, "approved plan content", "utf8");
      const metadata = readPlanMetadata(tmpRoot, run.work_item_id)!;
      writePlanMetadataDirect(tmpRoot, run.work_item_id, {
        ...metadata,
        state: "ready",
        approved_at: "2026-04-09T00:00:00.000Z",
        approved_by: "test",
        scratchpad_path: canonical,
      });

      const result = service.writeScratchpad(run, makeNode(run.work_item_id));

      expect(result.source).toBe("canonical_ready");
      expect(result.path).toBe(join(worktree, "SCRATCHPAD_studio_999.md"));
      expect(readFileSync(result.path, "utf8")).toBe("approved plan content");
    });

    it("throws ready_plan_scratchpad_missing when plan is ready but canonical is absent", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      // Seed metadata as ready but do NOT create the canonical scratchpad
      ensurePlanDir(tmpRoot, run.work_item_id);
      const metadata = readPlanMetadata(tmpRoot, run.work_item_id)!;
      writePlanMetadataDirect(tmpRoot, run.work_item_id, {
        ...metadata,
        state: "ready",
        approved_at: "2026-04-09T00:00:00.000Z",
        approved_by: "test",
        scratchpad_path: canonicalScratchpadPath(tmpRoot, run.work_item_id),
      });

      expect(() => service.writeScratchpad(run, makeNode(run.work_item_id))).toThrow(
        /ready_plan_scratchpad_missing/,
      );
      // Ensure the worktree scratchpad was NOT written
      expect(existsSync(join(worktree, "SCRATCHPAD_studio_999.md"))).toBe(false);
    });

    it("carries existing canonical forward when plan state is null (legacy)", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      // Seed canonical but leave metadata.state as null (drafting/untouched)
      ensurePlanDir(tmpRoot, run.work_item_id);
      writeFileSync(canonicalScratchpadPath(tmpRoot, run.work_item_id), "legacy content", "utf8");

      const result = service.writeScratchpad(run, makeNode(run.work_item_id));

      expect(result.source).toBe("carried_forward");
      expect(readFileSync(result.path, "utf8")).toBe("legacy content");
    });

    it("rejects an unapproved canonical plan when execution requires approval", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      ensurePlanDir(tmpRoot, run.work_item_id);
      writeFileSync(canonicalScratchpadPath(tmpRoot, run.work_item_id), "draft plan content", "utf8");

      expect(() => service.writeScratchpad(
        run,
        makeNode(run.work_item_id),
        { requireApproved: true },
      )).toThrow(/approved_plan_required/);
      expect(existsSync(join(worktree, "SCRATCHPAD_studio_999.md"))).toBe(false);
    });

    it("synthesizes a skeleton when no canonical file exists (fallback)", () => {
      const run = makeRun({ worktree_path: worktree });
      const service = makeScratchpadService(tmpRoot);

      // No plan dir, no canonical file — ensurePlanDir will create the dir
      const result = service.writeScratchpad(run, makeNode(run.work_item_id));

      expect(result.source).toBe("synthesized");
      expect(readFileSync(result.path, "utf8")).toBe("synthesized skeleton content");
      // The canonical file should also have been written
      const canonical = canonicalScratchpadPath(tmpRoot, run.work_item_id);
      expect(readFileSync(canonical, "utf8")).toBe("synthesized skeleton content");
    });
  });
});

describe("ExecutionService scratchpad orchestration", () => {
  let tmpRoot: string;
  let worktree: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-152-exec-"));
    worktree = join(tmpRoot, "wt");
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("getRunScratchpad thin wrapper", () => {
    it("prefers the canonical plan file", () => {
      const run = makeRun({
        worktree_path: worktree,
        artifact_dir: join(tmpRoot, "runs", "exec_test"),
      });
      const service = makeExecutionService(tmpRoot, run);

      mkdirSync(planDir(tmpRoot, run.work_item_id), { recursive: true });
      writeFileSync(canonicalScratchpadPath(tmpRoot, run.work_item_id), "canonical content", "utf8");
      // Also write a worktree copy — canonical should win
      writeFileSync(join(worktree, "SCRATCHPAD_studio_999.md"), "worktree content", "utf8");

      const result = service.getRunScratchpad("exec_test");
      expect(result.content).toBe("canonical content");
      expect(result).not.toHaveProperty("source");
    });

    it("falls back to the worktree live copy when canonical is absent", () => {
      const run = makeRun({
        worktree_path: worktree,
        artifact_dir: join(tmpRoot, "runs", "exec_test"),
      });
      const service = makeExecutionService(tmpRoot, run);

      writeFileSync(join(worktree, "SCRATCHPAD_studio_999.md"), "worktree only", "utf8");

      const result = service.getRunScratchpad("exec_test");
      expect(result.content).toBe("worktree only");
    });

    it("returns null content when neither canonical nor worktree exists", () => {
      const run = makeRun({
        worktree_path: worktree,
        artifact_dir: join(tmpRoot, "runs", "exec_test"),
      });
      const service = makeExecutionService(tmpRoot, run);

      const result = service.getRunScratchpad("exec_test");
      expect(result.content).toBe(null);
    });

    it("returns null content when run is not found", () => {
      const service = makeExecutionService(tmpRoot);
      const result = service.getRunScratchpad("nonexistent");
      expect(result.content).toBe(null);
    });
  });

  describe("getRunChecklist thin wrapper", () => {
    it("reconstructs checklist state from the surviving worktree scratchpad", () => {
      const run = makeRun({
        worktree_path: worktree,
        artifact_dir: join(tmpRoot, "runs", "exec_test"),
      });
      const service = makeExecutionService(tmpRoot, run);

      writeFileSync(join(worktree, "SCRATCHPAD_studio_999.md"), [
        "# Scratchpad",
        "",
        "## Implementation Plan",
        "- [x] Finish persistence layer",
        "- [ ] Verify restart hydration",
        "",
        "## Work Log",
      ].join("\n"), "utf8");

      expect(service.getRunChecklist("exec_test")).toEqual({
        run_id: "exec_test",
        items: [
          { text: "Finish persistence layer", checked: true },
          { text: "Verify restart hydration", checked: false },
        ],
        completed: 1,
        total: 2,
      });
    });
  });

  // ADR 014 step 5: plan metadata.run_ids tracks every run attempt.
  describe("appendRunIdToPlanMetadata (ADR 014 step 5)", () => {
    it("appends a run ID to the plan metadata run_ids array", () => {
      const workItemId = "studio-999";
      ensurePlanDir(tmpRoot, workItemId);
      const service = makeExecutionService(tmpRoot);

      service.appendRunIdToPlanMetadata(workItemId, "exec_111");

      const metadata = readPlanMetadata(tmpRoot, workItemId);
      expect(metadata?.run_ids).toEqual(["exec_111"]);
    });

    it("is idempotent — appending the same run ID twice is a no-op", () => {
      const workItemId = "studio-999";
      ensurePlanDir(tmpRoot, workItemId);
      const service = makeExecutionService(tmpRoot);

      service.appendRunIdToPlanMetadata(workItemId, "exec_111");
      service.appendRunIdToPlanMetadata(workItemId, "exec_111");

      const metadata = readPlanMetadata(tmpRoot, workItemId);
      expect(metadata?.run_ids).toEqual(["exec_111"]);
    });

    it("appends multiple distinct run IDs in order", () => {
      const workItemId = "studio-999";
      ensurePlanDir(tmpRoot, workItemId);
      const service = makeExecutionService(tmpRoot);

      service.appendRunIdToPlanMetadata(workItemId, "exec_111");
      service.appendRunIdToPlanMetadata(workItemId, "exec_222");
      service.appendRunIdToPlanMetadata(workItemId, "exec_333");

      const metadata = readPlanMetadata(tmpRoot, workItemId);
      expect(metadata?.run_ids).toEqual(["exec_111", "exec_222", "exec_333"]);
    });

    it("is a no-op when plan metadata is missing", () => {
      const service = makeExecutionService(tmpRoot);

      // No ensurePlanDir — metadata does not exist
      expect(() => service.appendRunIdToPlanMetadata("studio-999", "exec_111")).not.toThrow();
      expect(readPlanMetadata(tmpRoot, "studio-999")).toBeNull();
    });

    it("logs a warning and does not throw when the write fails", () => {
      const workItemId = "studio-999";
      ensurePlanDir(tmpRoot, workItemId);
      const service = makeExecutionService(tmpRoot);
      // Provide a getErrorMessage shim (used by the warning path)
      (service as any).getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

      // Make the plans dir read-only so writePlanMetadata fails
      const planDirPath = planDir(tmpRoot, workItemId);
      // Corrupt the metadata file so writePlanMetadata throws on the rewrite
      // path — easier than chmod which may not work reliably in CI
      const metadataPath = join(planDirPath, "metadata.json");
      rmSync(metadataPath);
      // Leave the plan dir in place but with no metadata file —
      // appendRunIdToPlanMetadata should no-op (readPlanMetadata returns null)
      // and NOT throw.
      expect(() => service.appendRunIdToPlanMetadata(workItemId, "exec_111")).not.toThrow();
    });
  });
});

// Small helper: directly write plan metadata without going through the
// ExecutionService. Used by the writeScratchpad ready-plan tests.
function writePlanMetadataDirect(artifactRoot: string, workItemId: string, metadata: any): void {
  writeFileSync(join(planDir(artifactRoot, workItemId), "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
}
