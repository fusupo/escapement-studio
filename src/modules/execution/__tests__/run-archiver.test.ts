import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDir, archivesRoot, runsRoot } from "../../../lib/context-layout.js";
import { archiveRunArtifactsForWorkItem, renderArchiveReadme } from "../run-archiver.js";
import type { ExecutionPullRequestRecord, ExecutionRunRecord } from "../types.js";
import type { WorkItemRecord } from "../../graph/types.js";

/**
 * Issue #86: tests use real `mkdtempSync` context roots so the archiver
 * exercises actual filesystem semantics (`renameSync`, `existsSync`,
 * `readdirSync`, `writeFileSync`). Harness pattern matches
 * `disposition.test.ts` and `scratchpad-canonical.test.ts`.
 */

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
    run_id: "exec_alpha",
    run_type: "execution",
    work_item_id: "studio-86",
    work_item_name: "Studio: archive execution run artifacts",
    status: "completed",
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T12:00:00.000Z",
    started_at: "2026-04-10T10:05:00.000Z",
    completed_at: "2026-04-10T12:00:00.000Z",
    repo: "fusupo/escapement-studio",
    issue_url: null,
    branch: "studio-86-branch",
    base_ref: "develop",
    worktree_path: "",
    artifact_dir: "",
    prompt: "do the thing",
    result_summary: "All tasks complete.",
    activity_log: [],
    changed_files: ["src/modules/execution/run-archiver.ts"],
    safety_checks: [],
    ...overrides,
  };
}

/**
 * Materialize a run dir under `runs/<run_id>/` with a minimal but
 * archiver-compatible file set: `status.json`, `events.jsonl`, and an
 * `outputs/` directory. Mirrors what `ExecutionService` writes during a
 * real run so the move semantics exercise realistic trees.
 */
function seedRunDir(artifactRoot: string, run: ExecutionRunRecord): string {
  const dir = join(runsRoot(artifactRoot), run.run_id);
  mkdirSync(join(dir, "outputs"), { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_completed","run_id":"${run.run_id}"}\n`, "utf8");
  writeFileSync(join(dir, "outputs", "response.json"), `{"assistant_text":"done"}`, "utf8");
  return dir;
}

describe("archiveRunArtifactsForWorkItem", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-86-archiver-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("archives every terminal run into archives/<slug>/runs/<run_id>/", () => {
    const runA = makeRun({ run_id: "exec_alpha", status: "completed" });
    const runB = makeRun({ run_id: "exec_beta", status: "error", result_summary: "Failed at step 2." });
    const srcA = seedRunDir(tmpRoot, runA);
    const srcB = seedRunDir(tmpRoot, runB);

    const workItem = makeWorkItem();
    const result = archiveRunArtifactsForWorkItem(tmpRoot, workItem, {
      runs: [runA, runB],
      now: () => "2026-04-11T13:00:00.000Z",
    });

    expect(result.work_item_id).toBe("studio-86");
    expect(result.archive_path).toBe(archiveDir(tmpRoot, "studio-86"));
    expect(result.archived_run_ids).toEqual(["exec_alpha", "exec_beta"]);
    expect(result.skipped_run_ids).toEqual([]);

    // Sources gone
    expect(existsSync(srcA)).toBe(false);
    expect(existsSync(srcB)).toBe(false);

    // Dests present with original files
    const destA = join(archiveDir(tmpRoot, "studio-86"), "runs", "exec_alpha");
    const destB = join(archiveDir(tmpRoot, "studio-86"), "runs", "exec_beta");
    expect(existsSync(join(destA, "status.json"))).toBe(true);
    expect(existsSync(join(destA, "events.jsonl"))).toBe(true);
    expect(existsSync(join(destA, "outputs", "response.json"))).toBe(true);
    expect(existsSync(join(destB, "status.json"))).toBe(true);

    // README written and result.readme_path matches
    expect(result.readme_path).toBe(join(archiveDir(tmpRoot, "studio-86"), "README.md"));
    const readme = readFileSync(result.readme_path!, "utf8");
    expect(readme).toContain("studio-86");
    expect(readme).toContain("exec_alpha");
    expect(readme).toContain("exec_beta");
    expect(readme).toContain("2026-04-11T13:00:00.000Z");
    expect(readme).toContain("Failed at step 2.");
  });

  it("refuses BEFORE any filesystem mutation when an active run exists", () => {
    const active = makeRun({ run_id: "exec_running", status: "running" });
    const completed = makeRun({ run_id: "exec_done", status: "completed" });
    const srcCompleted = seedRunDir(tmpRoot, completed);

    const workItem = makeWorkItem();
    expect(() =>
      archiveRunArtifactsForWorkItem(tmpRoot, workItem, { runs: [active, completed] }),
    ).toThrow(/archive_run_active.*exec_running/);

    // Source still there — guard ran before any mutation
    expect(existsSync(srcCompleted)).toBe(true);
    expect(existsSync(archivesRoot(tmpRoot))).toBe(false);
  });

  it("raises archive_already_exists_run on destination collision", () => {
    const run = makeRun({ run_id: "exec_collide" });
    const src = seedRunDir(tmpRoot, run);

    // Pre-create the destination so the move collides
    const destDir = join(archiveDir(tmpRoot, "studio-86"), "runs", "exec_collide");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "stale.json"), "{}", "utf8");

    const workItem = makeWorkItem();
    expect(() =>
      archiveRunArtifactsForWorkItem(tmpRoot, workItem, { runs: [run] }),
    ).toThrow(/archive_already_exists_run.*exec_collide/);

    // Source still present — fail-fast before move
    expect(existsSync(src)).toBe(true);
  });

  it("missing runs tree is a warn-and-README-only bundle (no-op move)", () => {
    const warnings: string[] = [];
    const workItem = makeWorkItem();
    const result = archiveRunArtifactsForWorkItem(tmpRoot, workItem, {
      runs: [],
      onWarn: (message) => warnings.push(message),
      now: () => "2026-04-11T13:00:00.000Z",
    });

    expect(result.archived_run_ids).toEqual([]);
    expect(result.skipped_run_ids).toEqual([]);
    expect(result.readme_path).toBe(join(archiveDir(tmpRoot, "studio-86"), "README.md"));
    expect(existsSync(result.readme_path!)).toBe(true);
    expect(warnings.join("\n")).toContain("no runs found for work item studio-86");

    const readme = readFileSync(result.readme_path!, "utf8");
    expect(readme).toContain("No terminal runs on disk");
  });

  it("records skipped_run_ids[reason=source_missing] when a terminal run's source dir vanished", () => {
    const runWithSource = makeRun({ run_id: "exec_present", status: "completed" });
    const runMissing = makeRun({ run_id: "exec_ghost", status: "completed" });
    seedRunDir(tmpRoot, runWithSource);
    // Intentionally do NOT seed runMissing's source dir

    const workItem = makeWorkItem();
    const result = archiveRunArtifactsForWorkItem(tmpRoot, workItem, {
      runs: [runWithSource, runMissing],
    });

    expect(result.archived_run_ids).toEqual(["exec_present"]);
    expect(result.skipped_run_ids).toEqual([{ run_id: "exec_ghost", reason: "source_missing" }]);
  });

  it("README includes a Pull request block when work_item.meta.studio_post_merge_sync.pull_request is present", () => {
    const run = makeRun({ run_id: "exec_pr" });
    seedRunDir(tmpRoot, run);
    const workItem = makeWorkItem({
      meta: {
        studio_post_merge_sync: {
          pull_request: {
            number: 184,
            url: "https://github.com/fusupo/escapement-studio/pull/184",
            title: "feat(execution): archiver",
            base_ref: "develop",
            head_ref: "studio-86-branch",
            is_draft: false,
            created_at: "2026-04-10T09:00:00.000Z",
            state: "merged",
            merged_at: "2026-04-11T10:00:00.000Z",
            merge_commit_sha: "abc123def",
          },
        },
      },
    });

    const result = archiveRunArtifactsForWorkItem(tmpRoot, workItem, { runs: [run] });
    const readme = readFileSync(result.readme_path!, "utf8");

    expect(readme).toContain("## Pull request");
    expect(readme).toContain("#184");
    expect(readme).toContain("https://github.com/fusupo/escapement-studio/pull/184");
    expect(readme).toContain("abc123def");
  });

  it("cross-links preserved plan dir artifacts when plan-dir archival ran first", () => {
    // Simulate: archiveAndCloseMergedPullRequest already moved plans/<slug>/ here
    const targetArchive = archiveDir(tmpRoot, "studio-86");
    mkdirSync(targetArchive, { recursive: true });
    writeFileSync(join(targetArchive, "SCRATCHPAD_studio_86.md"), "plan content", "utf8");
    writeFileSync(join(targetArchive, "metadata.json"), "{}", "utf8");

    const run = makeRun({ run_id: "exec_after_plan_archive" });
    seedRunDir(tmpRoot, run);

    const workItem = makeWorkItem();
    const result = archiveRunArtifactsForWorkItem(tmpRoot, workItem, { runs: [run] });
    const readme = readFileSync(result.readme_path!, "utf8");

    expect(readme).toContain("## Plan artifacts");
    expect(readme).toContain("SCRATCHPAD_studio_86.md");
    expect(readme).toContain("metadata.json");
  });

  it("falls back to disk scan when options.runs is not supplied", () => {
    const run = makeRun({ run_id: "exec_disk_scan" });
    seedRunDir(tmpRoot, run);
    // Also seed a run for a different work item — archiver must ignore it
    seedRunDir(tmpRoot, makeRun({ run_id: "exec_other", work_item_id: "studio-999" }));

    const workItem = makeWorkItem();
    const result = archiveRunArtifactsForWorkItem(tmpRoot, workItem);

    expect(result.archived_run_ids).toEqual(["exec_disk_scan"]);
    // Other work item's run left alone
    expect(existsSync(join(runsRoot(tmpRoot), "exec_other"))).toBe(true);
  });
});

describe("renderArchiveReadme", () => {
  it("renders core work item fields and archive metadata", () => {
    const workItem = makeWorkItem();
    const run = makeRun({ run_id: "exec_render", result_summary: "ok" });
    const readme = renderArchiveReadme(workItem, [run], {
      archivePath: "/tmp/archives/studio_86",
      archivedRunIds: ["exec_render"],
      skippedRunIds: [],
      archivedAt: "2026-04-11T13:00:00.000Z",
      pullRequest: null,
    });

    expect(readme).toContain("# Archive: studio-86");
    expect(readme).toContain("Studio: archive execution run artifacts");
    expect(readme).toContain("- **state:** merged_pr");
    expect(readme).toContain("- **archived_at:** 2026-04-11T13:00:00.000Z");
    expect(readme).toContain("/tmp/archives/studio_86");
    expect(readme).toContain("### Run `exec_render`");
    expect(readme).toContain("runs/exec_render/");
  });

  it("lists skipped runs when supplied", () => {
    const workItem = makeWorkItem();
    const readme = renderArchiveReadme(workItem, [], {
      archivePath: "/tmp/archives/studio_86",
      archivedRunIds: [],
      skippedRunIds: [{ run_id: "exec_skipped", reason: "not_terminal:running" }],
      archivedAt: "2026-04-11T13:00:00.000Z",
      pullRequest: null,
    });

    expect(readme).toContain("## Skipped runs");
    expect(readme).toContain("exec_skipped");
    expect(readme).toContain("not_terminal:running");
  });

  it("truncates long result summaries", () => {
    const workItem = makeWorkItem();
    const longSummary = "x".repeat(1000);
    const run = makeRun({ run_id: "exec_long", result_summary: longSummary });
    const readme = renderArchiveReadme(workItem, [run], {
      archivePath: "/tmp/archives/studio_86",
      archivedRunIds: ["exec_long"],
      skippedRunIds: [],
      archivedAt: "2026-04-11T13:00:00.000Z",
      pullRequest: null,
    });

    // Truncated to 480 chars plus ellipsis
    expect(readme).not.toContain("x".repeat(1000));
    expect(readme).toContain("x".repeat(480) + "\u2026");
  });
});
