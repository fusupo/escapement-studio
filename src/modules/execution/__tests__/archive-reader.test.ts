import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDir } from "../../../lib/context-layout.js";
import { listArchivedRunBundles, readArchivedRunBundle } from "../archive-reader.js";
import { renderArchiveReadme } from "../run-archiver.js";
import type { ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "studio-89",
    name: "Archived execution history",
    kind: "issue",
    state: "done",
    repo: "fusupo/escapement-studio",
    issue_number: 89,
    issue_url: "https://github.com/fusupo/escapement-studio/issues/89",
    scope_hint: null,
    branch: "studio-89-branch",
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
    run_id: "run-a",
    run_type: "execution",
    work_item_id: "studio-89",
    work_item_name: "Archived execution history",
    status: "completed",
    created_at: "2026-04-11T09:00:00.000Z",
    updated_at: "2026-04-11T10:00:00.000Z",
    completed_at: "2026-04-11T10:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "studio-89-branch",
    base_ref: "main",
    worktree_path: "/tmp/worktree",
    artifact_dir: "/tmp/run",
    prompt: "",
    result_summary: "short summary",
    activity_log: [],
    changed_files: ["a.ts", "b.ts"],
    safety_checks: [],
    ...overrides,
  };
}

function seedArchivedRun(artifactRoot: string, workItemId: string, run: ExecutionRunRecord) {
  const dir = join(archiveDir(artifactRoot, workItemId), "runs", run.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
}

function writeArchiveReadme(artifactRoot: string, workItem: WorkItemRecord, runs: ExecutionRunRecord[], archivedAt: string) {
  const dir = archiveDir(artifactRoot, workItem.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    renderArchiveReadme(workItem, runs, {
      archivePath: dir,
      archivedRunIds: runs.map((run) => run.run_id),
      skippedRunIds: [],
      archivedAt,
      pullRequest: runs[0]?.pull_request ?? null,
    }),
    "utf8",
  );
}

describe("archive-reader", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-89-archive-reader-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns [] when the archives root is missing", () => {
    expect(listArchivedRunBundles(tmpRoot)).toEqual([]);
  });

  it("lists mixed bundles and sorts by newest archived_at descending", () => {
    const newerWorkItem = makeWorkItem({ id: "studio-89", name: "Archived execution history" });
    const olderWorkItem = makeWorkItem({ id: "studio-90", name: "Older bundle", issue_number: 90, issue_url: "https://github.com/fusupo/escapement-studio/issues/90" });

    const newerRunA = makeRun({ run_id: "run-newer-a", completed_at: "2026-04-11T11:00:00.000Z", updated_at: "2026-04-11T11:00:00.000Z" });
    const newerRunB = makeRun({ run_id: "run-newer-b", completed_at: "2026-04-11T12:00:00.000Z", updated_at: "2026-04-11T12:00:00.000Z", result_summary: "x".repeat(500) });
    seedArchivedRun(tmpRoot, newerWorkItem.id, newerRunA);
    seedArchivedRun(tmpRoot, newerWorkItem.id, newerRunB);
    writeArchiveReadme(tmpRoot, newerWorkItem, [newerRunA, newerRunB], "2026-04-11T12:30:00.000Z");

    const olderRun = makeRun({
      run_id: "run-older",
      work_item_id: "studio-90",
      work_item_name: "Older bundle",
      completed_at: "2026-04-10T10:00:00.000Z",
      updated_at: "2026-04-10T10:00:00.000Z",
      branch: "studio-90-branch",
    });
    seedArchivedRun(tmpRoot, olderWorkItem.id, olderRun);
    writeArchiveReadme(tmpRoot, olderWorkItem, [olderRun], "2026-04-10T10:30:00.000Z");

    const bundles = listArchivedRunBundles(tmpRoot);
    expect(bundles.map((bundle) => bundle.work_item_id)).toEqual(["studio-89", "studio-90"]);
    expect(bundles[0].readme_exists).toBe(true);
    expect(bundles[0].runs.map((run) => run.run_id)).toEqual(["run-newer-b", "run-newer-a"]);
    expect(bundles[0].runs[0].result_summary?.length).toBeLessThan(500);
  });

  it("surfaces preserved plan artifacts for a plan-dir-only archive", () => {
    const dir = archiveDir(tmpRoot, "studio-91");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ work_item_id: "studio-91" }, null, 2), "utf8");
    writeFileSync(join(dir, "SCRATCHPAD_studio_91.md"), "# plan", "utf8");

    const bundles = listArchivedRunBundles(tmpRoot);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].work_item_id).toBe("studio-91");
    expect(bundles[0].readme_exists).toBe(false);
    expect(bundles[0].runs).toEqual([]);
    expect(bundles[0].plan_artifacts).toEqual({
      scratchpad_filename: "SCRATCHPAD_studio_91.md",
      metadata_filename: "metadata.json",
    });
  });

  it("warns and skips malformed archived status.json entries", () => {
    const warn = vi.fn();
    const dir = join(archiveDir(tmpRoot, "studio-92"), "runs", "run-bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), "{not-json", "utf8");
    writeFileSync(join(archiveDir(tmpRoot, "studio-92"), "metadata.json"), JSON.stringify({ work_item_id: "studio-92" }), "utf8");

    const bundles = listArchivedRunBundles(tmpRoot, { onWarn: warn });
    expect(bundles).toHaveLength(1);
    expect(bundles[0].runs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
  });

  it("returns README content verbatim from the detail reader and null when missing", () => {
    const workItem = makeWorkItem({ id: "studio-93", name: "Readme detail" });
    const run = makeRun({ run_id: "run-detail", work_item_id: "studio-93", work_item_name: "Readme detail" });
    seedArchivedRun(tmpRoot, workItem.id, run);
    writeArchiveReadme(tmpRoot, workItem, [run], "2026-04-11T13:00:00.000Z");

    const detail = readArchivedRunBundle(tmpRoot, "studio-93");
    expect(detail?.readme_content).toContain("# Archive: studio-93");

    const dir = archiveDir(tmpRoot, "studio-94");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ work_item_id: "studio-94" }), "utf8");
    const missingReadme = readArchivedRunBundle(tmpRoot, "studio-94");
    expect(missingReadme?.readme_content).toBeNull();
  });
});
