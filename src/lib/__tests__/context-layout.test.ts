import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVES_DIR,
  PLANS_DIR,
  PLAN_METADATA_FILE,
  RUNS_DIR,
  WORKTREES_DIR,
  archiveDir,
  archivesRoot,
  ensurePlanDir,
  planDir,
  plansRoot,
  runDir,
  runsRoot,
  workItemSlug,
  worktreeDir,
  worktreesRoot,
} from "../context-layout.js";

describe("workItemSlug", () => {
  it("passes alphanumeric ids through unchanged", () => {
    expect(workItemSlug("studio1234")).toBe("studio1234");
    expect(workItemSlug("Abc123")).toBe("Abc123");
  });

  it("replaces non-alphanumeric characters with underscores", () => {
    expect(workItemSlug("studio-1234")).toBe("studio_1234");
    expect(workItemSlug("Studio Foo")).toBe("Studio_Foo");
    expect(workItemSlug("foo.bar")).toBe("foo_bar");
    expect(workItemSlug("foo/bar")).toBe("foo_bar");
  });

  it("collapses runs of separators into a single underscore", () => {
    expect(workItemSlug("foo---bar")).toBe("foo_bar");
    expect(workItemSlug("foo   bar")).toBe("foo_bar");
    expect(workItemSlug("foo-_-bar")).toBe("foo_bar");
    expect(workItemSlug("a!!!b???c")).toBe("a_b_c");
  });

  it("trims leading and trailing separators", () => {
    expect(workItemSlug("__foo__")).toBe("foo");
    expect(workItemSlug("/foo/bar/")).toBe("foo_bar");
    expect(workItemSlug("---studio-1---")).toBe("studio_1");
  });

  it("throws when the result would be empty", () => {
    expect(() => workItemSlug("")).toThrow(/empty slug/);
    expect(() => workItemSlug("!!!")).toThrow(/empty slug/);
    expect(() => workItemSlug("___")).toThrow(/empty slug/);
    expect(() => workItemSlug("  ")).toThrow(/empty slug/);
  });

  it("throws on non-string input", () => {
    // @ts-expect-error — intentional invalid input
    expect(() => workItemSlug(undefined)).toThrow(TypeError);
    // @ts-expect-error — intentional invalid input
    expect(() => workItemSlug(null)).toThrow(TypeError);
  });
});

describe("path builders", () => {
  const root = "/tmp/fake-ctx";

  it("builds top-level root paths using the directory constants", () => {
    expect(plansRoot(root)).toBe(join(root, PLANS_DIR));
    expect(runsRoot(root)).toBe(join(root, RUNS_DIR));
    expect(worktreesRoot(root)).toBe(join(root, WORKTREES_DIR));
    expect(archivesRoot(root)).toBe(join(root, ARCHIVES_DIR));
  });

  it("builds a plan dir path from a work item id", () => {
    expect(planDir(root, "studio-1234")).toBe(join(root, PLANS_DIR, "studio_1234"));
  });

  it("builds a run dir path from a run id", () => {
    expect(runDir(root, "exec_1775629090122")).toBe(join(root, RUNS_DIR, "exec_1775629090122"));
  });

  it("builds a worktree dir path from a branch", () => {
    expect(worktreeDir(root, "studio-42-branch")).toBe(join(root, WORKTREES_DIR, "studio-42-branch"));
  });

  it("builds an archive dir path from a work item id", () => {
    expect(archiveDir(root, "studio-1234")).toBe(join(root, ARCHIVES_DIR, "studio_1234"));
  });
});

describe("ensurePlanDir", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-151-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates the plan dir and writes a metadata marker on first call", () => {
    const dir = ensurePlanDir(tmpRoot, "studio-1234");

    expect(dir).toBe(join(tmpRoot, PLANS_DIR, "studio_1234"));
    expect(existsSync(dir)).toBe(true);

    const metadataPath = join(dir, PLAN_METADATA_FILE);
    expect(existsSync(metadataPath)).toBe(true);

    const marker = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(marker.plan_id).toBe("studio_1234");
    expect(marker.work_item_id).toBe("studio-1234");
    expect(typeof marker.created_at).toBe("string");
  });

  it("is idempotent when called twice for the same work item id", () => {
    const first = ensurePlanDir(tmpRoot, "studio-1234");
    const firstMarker = readFileSync(join(first, PLAN_METADATA_FILE), "utf8");

    const second = ensurePlanDir(tmpRoot, "studio-1234");
    const secondMarker = readFileSync(join(second, PLAN_METADATA_FILE), "utf8");

    expect(second).toBe(first);
    // The second call should NOT rewrite the marker (preserves original created_at)
    expect(secondMarker).toBe(firstMarker);
  });

  it("throws on slug collision when a different work item id already owns the slug", () => {
    ensurePlanDir(tmpRoot, "studio-1234");

    // Both of these normalize to "studio_1234" but reference different work items
    expect(() => ensurePlanDir(tmpRoot, "studio_1234")).toThrow(/slug collision/);
    expect(() => ensurePlanDir(tmpRoot, "studio.1234")).toThrow(/slug collision/);
  });

  it("throws a clear error when an existing metadata marker is corrupt", () => {
    const slug = workItemSlug("studio-1234");
    const dir = join(tmpRoot, PLANS_DIR, slug);
    const metadataPath = join(dir, PLAN_METADATA_FILE);
    // Create a corrupt marker file
    mkdirSync(dir, { recursive: true });
    writeFileSync(metadataPath, "{ this is not json", "utf8");

    expect(() => ensurePlanDir(tmpRoot, "studio-1234")).toThrow(/could not be parsed/);
  });

  it("throws when the work item id would produce an empty slug", () => {
    expect(() => ensurePlanDir(tmpRoot, "!!!")).toThrow(/empty slug/);
  });
});
