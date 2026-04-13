import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RunDispositionService } from "../run-disposition.service.js";
import { loadRunRecordsForArtifactRoot } from "../run-disk-store.js";
import { archiveDir, runsRoot } from "../../../lib/context-layout.js";
import type { ExecutionRunRecord, ExecutionRunStatus } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

/**
 * Issue #86 / Phase 3 (#223): tests for the `archiveRunArtifacts` wrapper,
 * now owned by `RunDispositionService`. Uses the same prototype-harness
 * pattern as `disposition.test.ts` \u2014 real filesystem root via `mkdtempSync`,
 * mocked `workItemsService`, stubbed in-memory run buffer via a fake
 * `executionService.listRecentRuns`, and the service instance built via
 * `Object.create(RunDispositionService.prototype)`.
 */

interface HarnessService {
  artifactRoot: string;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  workItemsService: {
    get: (id: string) => WorkItemRecord;
    update: (id: string, patch: Partial<WorkItemRecord>) => WorkItemRecord;
  };
  runStore: {
    listRecentRuns: () => ExecutionRunRecord[];
    captureRunSnapshotForWorkItem: (workItemId: string) => ExecutionRunRecord[];
  };
  archiveRunArtifacts: RunDispositionService["archiveRunArtifacts"];
  assertNoActiveRunForWorkItem: (id: string) => void;
  getErrorMessage: (err: unknown) => string;
}

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-86",
    name: "Studio: archive execution run artifacts",
    kind: "issue",
    state: "merged_pr",
    repo: "fusupo/escapement-studio",
    issue_number: 86,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/86",
    scope_hint: null,
    branch: "studio-86-branch",
    archive_path: null,
    predicted_files: [],
    actual_files: [],
    meta: {},
    updated_at: "2026-04-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "exec_wrap",
    run_type: "execution",
    work_item_id: "studio-86",
    work_item_name: "Studio: archive execution run artifacts",
    status: "completed",
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T12:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "studio-86-branch",
    base_ref: "develop",
    worktree_path: "",
    artifact_dir: "",
    prompt: "",
    activity_log: [],
    safety_checks: [],
    ...overrides,
  };
}

function seedRunDir(artifactRoot: string, run: ExecutionRunRecord): string {
  const dir = join(runsRoot(artifactRoot), run.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_completed"}\n`, "utf8");
  return dir;
}

function makeService(params: {
  artifactRoot: string;
  workItem?: WorkItemRecord;
  runs?: ExecutionRunRecord[];
}): HarnessService {
  const service = Object.create(RunDispositionService.prototype) as HarnessService;
  const workItem = params.workItem ?? makeWorkItem();

  service.artifactRoot = params.artifactRoot;
  service.logger = { log: vi.fn(), warn: vi.fn() };
  service.workItemsService = {
    get: (id: string) => {
      if (id !== workItem.id) throw new NotFoundException(`not found: ${id}`);
      return workItem;
    },
    update: (_id, _patch) => workItem,
  };
  // Phase 4a: RunDispositionService.archiveRunArtifacts delegates to
  // `runStore.listRecentRuns()` via `assertNoActiveRunForWorkItem`
  // AND to `runStore.captureRunSnapshotForWorkItem()` for the merged
  // in-memory+disk snapshot. The fake below mirrors the production
  // semantics of both (buffer scan, disk merge, dedup by run_id).
  service.runStore = {
    listRecentRuns: () => params.runs ?? [],
    captureRunSnapshotForWorkItem: (workItemId: string) => {
      const merged: ExecutionRunRecord[] = [];
      const seen = new Set<string>();
      for (const run of params.runs ?? []) {
        if (run.work_item_id !== workItemId) continue;
        if (seen.has(run.run_id)) continue;
        merged.push(run);
        seen.add(run.run_id);
      }
      try {
        const diskRuns = loadRunRecordsForArtifactRoot(params.artifactRoot);
        for (const run of diskRuns) {
          if (run.work_item_id !== workItemId) continue;
          if (seen.has(run.run_id)) continue;
          merged.push(run);
          seen.add(run.run_id);
        }
      } catch {
        // swallow — tests that don't seed disk dirs hit this path
      }
      return merged;
    },
  };
  return service;
}

describe("RunDispositionService.archiveRunArtifacts", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-86-wrap-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("archives terminal runs loaded from the in-memory buffer", () => {
    const run = makeRun({ run_id: "exec_from_memory", status: "completed" });
    seedRunDir(tmpRoot, run);

    const service = makeService({ artifactRoot: tmpRoot, runs: [run] });
    const result = service.archiveRunArtifacts("studio-86");

    expect(result.work_item_id).toBe("studio-86");
    expect(result.archive_path).toBe(archiveDir(tmpRoot, "studio-86"));
    expect(result.archived_run_ids).toEqual(["exec_from_memory"]);
    expect(result.readme_path).toBe(join(archiveDir(tmpRoot, "studio-86"), "README.md"));
    expect(existsSync(result.readme_path!)).toBe(true);

    const readme = readFileSync(result.readme_path!, "utf8");
    expect(readme).toContain("studio-86");
    expect(readme).toContain("exec_from_memory");
  });

  it("falls back to the disk scan when recentRuns is empty (post-restart case)", () => {
    const run = makeRun({ run_id: "exec_from_disk", status: "completed" });
    seedRunDir(tmpRoot, run);

    // recentRuns empty — mimics a fresh server after restart
    const service = makeService({ artifactRoot: tmpRoot, runs: [] });
    const result = service.archiveRunArtifacts("studio-86");

    expect(result.archived_run_ids).toEqual(["exec_from_disk"]);
    expect(existsSync(join(archiveDir(tmpRoot, "studio-86"), "runs", "exec_from_disk"))).toBe(true);
  });

  it.each<ExecutionRunStatus>(["queued", "preparing", "disambiguating", "running"])(
    "refuses with BadRequestException when an active run (status=%s) exists",
    (status) => {
      const activeRun = makeRun({ run_id: "exec_active", status });
      const service = makeService({ artifactRoot: tmpRoot, runs: [activeRun] });

      expect(() => service.archiveRunArtifacts("studio-86")).toThrow(BadRequestException);
      expect(() => service.archiveRunArtifacts("studio-86")).toThrow(
        /cannot_dispose_work_item_active_run/,
      );
      // Archive dir not created
      expect(existsSync(archiveDir(tmpRoot, "studio-86"))).toBe(false);
    },
  );

  it("translates archiver collision errors into BadRequestException", () => {
    const run = makeRun({ run_id: "exec_collide" });
    seedRunDir(tmpRoot, run);

    // Pre-create destination
    const destDir = join(archiveDir(tmpRoot, "studio-86"), "runs", "exec_collide");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "stale.json"), "{}", "utf8");

    const service = makeService({ artifactRoot: tmpRoot, runs: [run] });
    expect(() => service.archiveRunArtifacts("studio-86")).toThrow(BadRequestException);
    expect(() => service.archiveRunArtifacts("studio-86")).toThrow(/archive_already_exists_run/);
  });

  it("requires a non-empty work_item_id", () => {
    const service = makeService({ artifactRoot: tmpRoot });
    expect(() => service.archiveRunArtifacts("")).toThrow(BadRequestException);
    expect(() => service.archiveRunArtifacts("   ")).toThrow(BadRequestException);
  });

  it("propagates NotFoundException when the work item does not exist", () => {
    const service = makeService({ artifactRoot: tmpRoot });
    expect(() => service.archiveRunArtifacts("studio-missing")).toThrow(NotFoundException);
  });

  it("dedupes runs present in both in-memory and disk sources", () => {
    const run = makeRun({ run_id: "exec_dup", status: "completed" });
    seedRunDir(tmpRoot, run);

    // Same run appears in recentRuns too — shared source of truth
    const service = makeService({ artifactRoot: tmpRoot, runs: [run] });
    const result = service.archiveRunArtifacts("studio-86");

    expect(result.archived_run_ids).toEqual(["exec_dup"]);
  });
});
