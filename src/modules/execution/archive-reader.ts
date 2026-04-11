import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { archivesRoot, workItemSlug } from "../../lib/context-layout.js";
import { coerceRecord } from "./run-disk-store.js";
import type { ArchivedRunBundle, ArchivedRunSummary, ExecutionPullRequestRecord, ExecutionRunRecord } from "./types.js";

interface ArchiveReaderOptions {
  onWarn?: (message: string) => void;
}

interface BundleParts {
  readmeContent: string | null;
  metadata: Record<string, unknown> | null;
}

export function listArchivedRunBundles(
  artifactRoot: string,
  options: ArchiveReaderOptions = {},
): ArchivedRunBundle[] {
  const root = archivesRoot(artifactRoot);
  const warn = options.onWarn ?? ((message) => console.warn(`[archive-reader] ${message}`));
  if (!existsSync(root)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    warn(`failed to read archives root ${root}: ${formatError(error)}`);
    return [];
  }

  const bundles: ArchivedRunBundle[] = [];
  for (const slug of entries) {
    const archivePath = join(root, slug);
    try {
      if (!statSync(archivePath).isDirectory()) continue;
    } catch {
      continue;
    }

    const bundle = readBundleFromDir(archivePath, slug, { ...options, onWarn: warn }, false);
    if (bundle) bundles.push(bundle);
  }

  bundles.sort((left, right) => right.archived_at.localeCompare(left.archived_at));
  return bundles;
}

export function readArchivedRunBundle(
  artifactRoot: string,
  workItemId: string,
  options: ArchiveReaderOptions = {},
): ArchivedRunBundle | null {
  const slug = workItemSlug(workItemId);
  const archivePath = join(archivesRoot(artifactRoot), slug);
  if (!existsSync(archivePath)) {
    return null;
  }
  return readBundleFromDir(archivePath, slug, options, true);
}

function readBundleFromDir(
  archivePath: string,
  slug: string,
  options: ArchiveReaderOptions,
  includeReadmeContent: boolean,
): ArchivedRunBundle | null {
  const warn = options.onWarn ?? ((message) => console.warn(`[archive-reader] ${message}`));
  const { readmeContent, metadata } = readBundleParts(archivePath, warn);
  const runs = readArchivedRuns(archivePath, warn);
  const stat = safeStat(archivePath);

  const workItemId = inferWorkItemId({ slug, readmeContent, metadata, runs });
  if (!workItemId) {
    warn(`archive bundle ${archivePath} missing work item identity; skipping`);
    return null;
  }

  const workItemName = inferWorkItemName({ readmeContent, metadata, runs, fallback: workItemId });
  const readmePath = join(archivePath, "README.md");
  const readmeExists = readmeContent !== null;
  const archivedAt = inferArchivedAt({ readmeContent, statMtimeMs: stat?.mtimeMs ?? Date.now() });
  const pullRequest = inferPullRequest({ readmeContent, metadata, runs });
  const planArtifacts = inferPlanArtifacts(archivePath);

  const bundle: ArchivedRunBundle = {
    work_item_id: workItemId,
    work_item_name: workItemName,
    slug,
    archive_path: archivePath,
    readme_path: readmeExists ? readmePath : null,
    readme_exists: readmeExists,
    archived_at: archivedAt,
    pull_request: pullRequest,
    runs,
    ...(planArtifacts ? { plan_artifacts: planArtifacts } : {}),
    ...(includeReadmeContent ? { readme_content: readmeContent } : {}),
  };

  return bundle;
}

function readBundleParts(archivePath: string, warn: (message: string) => void): BundleParts {
  const readmePath = join(archivePath, "README.md");
  const metadataPath = join(archivePath, "metadata.json");

  let readmeContent: string | null = null;
  if (existsSync(readmePath)) {
    try {
      readmeContent = readFileSync(readmePath, "utf8");
    } catch (error) {
      warn(`failed to read ${readmePath}: ${formatError(error)}`);
    }
  }

  let metadata: Record<string, unknown> | null = null;
  if (existsSync(metadataPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        metadata = parsed as Record<string, unknown>;
      } else {
        warn(`metadata.json at ${metadataPath} did not contain an object; ignoring`);
      }
    } catch (error) {
      warn(`failed to parse ${metadataPath}: ${formatError(error)}`);
    }
  }

  return { readmeContent, metadata };
}

function readArchivedRuns(archivePath: string, warn: (message: string) => void): ArchivedRunSummary[] {
  const root = join(archivePath, "runs");
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    warn(`failed to read archived runs dir ${root}: ${formatError(error)}`);
    return [];
  }

  const runs: ArchivedRunSummary[] = [];
  for (const entry of entries) {
    const runDir = join(root, entry);
    const statusPath = join(runDir, "status.json");
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(statusPath)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch (error) {
      warn(`malformed JSON in ${statusPath}: ${formatError(error)}`);
      continue;
    }

    const record = coerceRecord(parsed);
    if (!record) {
      warn(`status.json at ${statusPath} did not match ExecutionRunRecord shape; skipping archived run`);
      continue;
    }
    runs.push(toArchivedRunSummary(record, runDir));
  }

  runs.sort(compareArchivedRuns);
  return runs;
}

function toArchivedRunSummary(record: ExecutionRunRecord, archivedRunDir: string): ArchivedRunSummary {
  return {
    run_id: record.run_id,
    status: record.status,
    branch: record.branch,
    base_ref: record.base_ref,
    created_at: record.created_at,
    completed_at: record.completed_at,
    changed_file_count: record.changed_files?.length ?? 0,
    result_summary: truncateResultSummary(record.result_summary),
    pull_request: record.pull_request,
    archived_run_dir: archivedRunDir,
  };
}

function compareArchivedRuns(left: ArchivedRunSummary, right: ArchivedRunSummary): number {
  const leftKey = left.completed_at ?? left.created_at ?? "";
  const rightKey = right.completed_at ?? right.created_at ?? "";
  return rightKey.localeCompare(leftKey);
}

function inferWorkItemId(input: {
  slug: string;
  readmeContent: string | null;
  metadata: Record<string, unknown> | null;
  runs: ArchivedRunSummary[];
}): string | null {
  const readmeTitle = input.readmeContent?.match(/^# Archive: (.+?) — /m)?.[1]?.trim();
  if (readmeTitle) return readmeTitle;
  const metadataId = typeof input.metadata?.work_item_id === "string" ? input.metadata.work_item_id : null;
  if (metadataId) return metadataId;
  const runId = input.runs[0]?.run_id;
  if (runId) {
    // identity comes from the archived status records; use the first full record if available
    const statusPath = join(input.runs[0].archived_run_dir, "status.json");
    try {
      const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
      const record = coerceRecord(parsed);
      if (record?.work_item_id) return record.work_item_id;
    } catch {
      // ignore; caller already validated during run scan
    }
  }
  return input.metadata ? input.slug : null;
}

function inferWorkItemName(input: {
  readmeContent: string | null;
  metadata: Record<string, unknown> | null;
  runs: ArchivedRunSummary[];
  fallback: string;
}): string {
  const titleMatch = input.readmeContent?.match(/^# Archive: .+? — (.+)$/m)?.[1]?.trim();
  if (titleMatch) return titleMatch;

  if (input.runs[0]) {
    const statusPath = join(input.runs[0].archived_run_dir, "status.json");
    try {
      const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
      const record = coerceRecord(parsed);
      if (record?.work_item_name) return record.work_item_name;
    } catch {
      // ignore; caller already validated during run scan
    }
  }

  return typeof input.metadata?.work_item_name === "string" ? input.metadata.work_item_name : input.fallback;
}

function inferArchivedAt(input: { readmeContent: string | null; statMtimeMs: number }): string {
  const value = input.readmeContent?.match(/^- \*\*archived_at:\*\* (.+)$/m)?.[1]?.trim();
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(input.statMtimeMs).toISOString();
}

function inferPullRequest(input: {
  readmeContent: string | null;
  metadata: Record<string, unknown> | null;
  runs: ArchivedRunSummary[];
}): ExecutionPullRequestRecord | null {
  for (const run of input.runs) {
    if (run.pull_request) return run.pull_request;
  }

  const readmePr = parsePullRequestFromReadme(input.readmeContent);
  if (readmePr) return readmePr;

  const metadataPr = (input.metadata?.pull_request ?? input.metadata?.pr) as Record<string, unknown> | undefined;
  if (metadataPr && typeof metadataPr === "object") {
    return coercePullRequest(metadataPr);
  }

  return null;
}

function parsePullRequestFromReadme(readmeContent: string | null): ExecutionPullRequestRecord | null {
  if (!readmeContent || !readmeContent.includes("## Pull request")) return null;
  const block = readmeContent.split("## Pull request")[1]?.split("## ")[0] ?? "";
  const numberMatch = block.match(/^- \*\*number:\*\* #?(\d+)/m);
  const urlMatch = block.match(/^- \*\*url:\*\* (.+)$/m);
  if (!numberMatch || !urlMatch) return null;
  return {
    number: Number(numberMatch[1]),
    url: urlMatch[1].trim(),
    title: block.match(/^- \*\*title:\*\* (.+)$/m)?.[1]?.trim() ?? "",
    body: "",
    base_ref: block.match(/^- \*\*base_ref:\*\* (.+)$/m)?.[1]?.trim() ?? "",
    head_ref: block.match(/^- \*\*head_ref:\*\* (.+)$/m)?.[1]?.trim() ?? "",
    is_draft: false,
    created_at: "",
    state: block.match(/^- \*\*state:\*\* (.+)$/m)?.[1]?.trim(),
    merged_at: block.match(/^- \*\*merged_at:\*\* (.+)$/m)?.[1]?.trim() ?? null,
    merge_commit_sha: block.match(/^- \*\*merge_commit_sha:\*\* `(.+)`$/m)?.[1]?.trim() ?? null,
  };
}

function coercePullRequest(raw: Record<string, unknown>): ExecutionPullRequestRecord | null {
  if (typeof raw.number !== "number" || typeof raw.url !== "string") return null;
  return {
    number: raw.number,
    url: raw.url,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    base_ref: typeof raw.base_ref === "string" ? raw.base_ref : "",
    head_ref: typeof raw.head_ref === "string" ? raw.head_ref : "",
    is_draft: Boolean(raw.is_draft),
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    state: typeof raw.state === "string" ? raw.state : undefined,
    merged_at: typeof raw.merged_at === "string" ? raw.merged_at : null,
    merge_commit_sha: typeof raw.merge_commit_sha === "string" ? raw.merge_commit_sha : null,
  };
}

function inferPlanArtifacts(archivePath: string): ArchivedRunBundle["plan_artifacts"] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(archivePath);
  } catch {
    return undefined;
  }

  const scratchpadFilename = entries.find((entry) => entry.startsWith("SCRATCHPAD_") && entry.endsWith(".md"));
  const metadataFilename = entries.includes("metadata.json") ? "metadata.json" : undefined;
  if (!scratchpadFilename && !metadataFilename) return undefined;
  return {
    ...(scratchpadFilename ? { scratchpad_filename: scratchpadFilename } : {}),
    ...(metadataFilename ? { metadata_filename: metadataFilename } : {}),
  };
}

function truncateResultSummary(value: string | undefined, max = 280): string | undefined {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
