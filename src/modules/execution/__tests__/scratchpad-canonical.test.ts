import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../execution.service.js";
import type { ExecutionRunRecord } from "../types.js";
import { canonicalScratchpadPath, planDir } from "../../../lib/context-layout.js";

/**
 * Canonical scratchpad behavior (ADR 014 step 2).
 *
 * Tests use Object.create to bypass DI and inject the artifactRoot + a
 * minimal run record, matching the pattern in build-scratchpad.test.ts and
 * launch-eligibility.test.ts.
 */

interface HarnessService {
  artifactRoot: string;
  logger: { warn: (msg: string) => void };
  warnings: string[];
  syncScratchpadToCanonical: ExecutionService["syncScratchpadToCanonical"];
  getRunScratchpad: ExecutionService["getRunScratchpad"];
  writeScratchpad: ExecutionService["writeScratchpad"];
  getRun: (runId: string) => ExecutionRunRecord | undefined;
}

function makeService(artifactRoot: string, run?: ExecutionRunRecord): HarnessService {
  const service = Object.create(ExecutionService.prototype) as HarnessService;
  service.artifactRoot = artifactRoot;
  service.warnings = [];
  service.logger = {
    warn: (msg: string) => {
      service.warnings.push(msg);
    },
  };
  service.getRun = (runId: string) => (run && run.run_id === runId ? run : undefined);
  return service;
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

describe("ExecutionService scratchpad canonical flow", () => {
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
      const service = makeService(tmpRoot, run);

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
      const service = makeService(tmpRoot, run);

      // Seed canonical with prior content; no worktree scratchpad
      mkdirSync(planDir(tmpRoot, run.work_item_id), { recursive: true });
      const canonical = canonicalScratchpadPath(tmpRoot, run.work_item_id);
      writeFileSync(canonical, "last-known-good", "utf8");

      expect(() => service.syncScratchpadToCanonical(run)).not.toThrow();
      expect(readFileSync(canonical, "utf8")).toBe("last-known-good");
      expect(service.warnings.some((w) => w.includes("worktree scratchpad missing"))).toBe(true);
    });
  });

  describe("getRunScratchpad", () => {
    it("prefers the canonical plan file", () => {
      const run = makeRun({
        worktree_path: worktree,
        artifact_dir: join(tmpRoot, "runs", "exec_test"),
      });
      const service = makeService(tmpRoot, run);

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
      const service = makeService(tmpRoot, run);

      writeFileSync(join(worktree, "SCRATCHPAD_studio_999.md"), "worktree only", "utf8");

      const result = service.getRunScratchpad("exec_test");
      expect(result.content).toBe("worktree only");
    });

    it("returns null content when neither canonical nor worktree exists", () => {
      const run = makeRun({
        worktree_path: worktree,
        artifact_dir: join(tmpRoot, "runs", "exec_test"),
      });
      const service = makeService(tmpRoot, run);

      const result = service.getRunScratchpad("exec_test");
      expect(result.content).toBe(null);
    });

    it("returns null content when run is not found", () => {
      const service = makeService(tmpRoot);
      const result = service.getRunScratchpad("nonexistent");
      expect(result.content).toBe(null);
    });
  });
});
