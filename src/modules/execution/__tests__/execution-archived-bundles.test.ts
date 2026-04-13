import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { ExecutionService } from "../execution.service.js";
import { ExecutionController } from "../execution.controller.js";
import { archiveDir } from "../../../lib/context-layout.js";
import type { WorkItemRecord } from "../../graph/types.js";
import type { ExecutionRunRecord } from "../types.js";

interface HarnessService {
  artifactRoot: string;
  logger: { warn: ReturnType<typeof vi.fn> };
  workItemsService: { get: (id: string) => WorkItemRecord };
  listArchivedRunBundles: ExecutionService["listArchivedRunBundles"];
  getArchivedRunBundle: ExecutionService["getArchivedRunBundle"];
}

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
    run_id: "run-89",
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
    activity_log: [],
    safety_checks: [],
    result_summary: "summary",
    changed_files: ["src/a.ts"],
    ...overrides,
  };
}

function seedArchive(artifactRoot: string, workItem: WorkItemRecord, run: ExecutionRunRecord) {
  const dir = join(archiveDir(artifactRoot, workItem.id), "runs", run.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(run, null, 2), "utf8");
  writeFileSync(join(archiveDir(artifactRoot, workItem.id), "README.md"), `# Archive: ${workItem.id} — ${workItem.name}\n\n- **archived_at:** 2026-04-11T11:00:00.000Z\n`, "utf8");
}

function makeService(tmpRoot: string, workItem = makeWorkItem()): HarnessService {
  const service = Object.create(ExecutionService.prototype) as HarnessService;
  service.artifactRoot = tmpRoot;
  service.logger = { warn: vi.fn() };
  service.workItemsService = {
    get: (id: string) => {
      if (id !== workItem.id) throw new NotFoundException(`not found: ${id}`);
      return workItem;
    },
  };
  return service;
}

describe("ExecutionService archived bundles", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "studio-89-service-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("lists archived bundles and returns bundle detail including README content", () => {
    const workItem = makeWorkItem();
    seedArchive(tmpRoot, workItem, makeRun());
    const service = makeService(tmpRoot, workItem);

    const list = service.listArchivedRunBundles();
    expect(list).toHaveLength(1);
    expect(list[0].work_item_id).toBe("studio-89");
    expect(list[0].readme_content).toBeUndefined();

    const detail = service.getArchivedRunBundle("studio-89");
    expect(detail.readme_content).toContain("# Archive: studio-89");
    expect(detail.runs[0].run_id).toBe("run-89");
  });

  it("throws NotFoundException when the work item exists but has no archive dir", () => {
    const service = makeService(tmpRoot, makeWorkItem());
    expect(() => service.getArchivedRunBundle("studio-89")).toThrow(NotFoundException);
  });
});

describe("ExecutionController archived bundle routes", () => {
  it("forwards list/detail calls to the execution service", () => {
    const executionService = {
      listArchivedRunBundles: vi.fn(() => [{ work_item_id: "studio-89" }]),
      getArchivedRunBundle: vi.fn(() => ({ work_item_id: "studio-89", readme_content: "# Archive" })),
    } as unknown as ExecutionService;

    const controller = new ExecutionController(executionService, {} as never, {} as never);
    expect(controller.getArchivedRunBundles()).toEqual([{ work_item_id: "studio-89" }]);
    expect(controller.getArchivedRunBundle("studio-89")).toEqual({ work_item_id: "studio-89", readme_content: "# Archive" });
  });
});
