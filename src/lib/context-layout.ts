import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Centralized filesystem layout for the Studio context root.
 *
 * Implements ADR 014 step 1: introduces the `plans/<slug>/` directory
 * convention and derives stable slugs from work item ids. This module is the
 * single source of truth for context-root path construction — execution and
 * sub-agent services should reference these helpers instead of inlining joins.
 *
 * See docs/adr/014-plans-runs-state-model.md and
 * docs/contracts/plan-and-run-lifecycle.md.
 */

/** Top-level directory names under the context root. */
export const PLANS_DIR = "plans";
export const RUNS_DIR = "runs";
export const WORKTREES_DIR = "worktrees";
export const ARCHIVES_DIR = "archives";

/** Per-plan metadata sidecar filename, used for slug collision detection. */
export const PLAN_METADATA_FILE = "metadata.json";

/**
 * Derive a stable plan-dir slug from a work item id.
 *
 * Rules (from ADR 014):
 *   1. Replace every non-alphanumeric character with `_`
 *   2. Collapse runs of `_` to a single `_`
 *   3. Trim leading/trailing `_`
 *
 * Throws if the resulting slug is empty (e.g. input was empty or contained
 * only non-alphanumeric characters).
 *
 * @example
 *   workItemSlug("studio-1234")  // → "studio_1234"
 *   workItemSlug("Studio Foo")   // → "Studio_Foo"
 *   workItemSlug("foo---bar")    // → "foo_bar"
 *   workItemSlug("__foo__")      // → "foo"
 */
export function workItemSlug(workItemId: string): string {
  if (typeof workItemId !== "string") {
    throw new TypeError(`workItemSlug: expected string, got ${typeof workItemId}`);
  }

  const replaced = workItemId.replace(/[^a-zA-Z0-9]+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");

  if (!trimmed) {
    throw new Error(
      `workItemSlug: work item id ${JSON.stringify(workItemId)} produced an empty slug after normalization`,
    );
  }

  return trimmed;
}

/* ── Top-level root path builders ────────────────────────────────────────── */

export function plansRoot(artifactRoot: string): string {
  return join(artifactRoot, PLANS_DIR);
}

export function runsRoot(artifactRoot: string): string {
  return join(artifactRoot, RUNS_DIR);
}

export function worktreesRoot(artifactRoot: string): string {
  return join(artifactRoot, WORKTREES_DIR);
}

export function archivesRoot(artifactRoot: string): string {
  return join(artifactRoot, ARCHIVES_DIR);
}

/* ── Entity path builders ────────────────────────────────────────────────── */

/**
 * Path to the canonical plan directory for a work item.
 * Does not touch the filesystem — use `ensurePlanDir` to create it.
 */
export function planDir(artifactRoot: string, workItemId: string): string {
  return join(plansRoot(artifactRoot), workItemSlug(workItemId));
}

/** Path to a run directory by run id. */
export function runDir(artifactRoot: string, runId: string): string {
  return join(runsRoot(artifactRoot), runId);
}

/** Path to a worktree directory by branch name (or any safe directory name). */
export function worktreeDir(artifactRoot: string, branch: string): string {
  return join(worktreesRoot(artifactRoot), branch);
}

/** Path to an archive directory for a work item. */
export function archiveDir(artifactRoot: string, workItemId: string): string {
  return join(archivesRoot(artifactRoot), workItemSlug(workItemId));
}

/** Return true when the canonical `archives/<slug>/` bundle exists on disk. */
export function archiveBundleExists(artifactRoot: string, workItemId: string): boolean {
  const path = archiveDir(artifactRoot, workItemId);
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Path to the canonical scratchpad file for a work item's plan.
 *
 * Returns `plans/<slug>/SCRATCHPAD_<slug>.md`. This is the single source of
 * truth for plan content per ADR 014 — execution copies this file into the
 * worktree at run launch and syncs it back at phase boundaries.
 */
export function canonicalScratchpadPath(artifactRoot: string, workItemId: string): string {
  const slug = workItemSlug(workItemId);
  return join(planDir(artifactRoot, workItemId), `SCRATCHPAD_${slug}.md`);
}

/* ── Plan metadata schema ────────────────────────────────────────────────── */

/**
 * ADR 014 plan state. Mirrors the prepared-plan phase of the work item
 * lifecycle.
 *
 * - `null` — legacy or execution-launched plan dir that was created without
 *   going through the prepare-plan flow. Step 4 introduces prepare/approve
 *   as an explicit path; existing callers (ExecutionService) still create
 *   plan dirs directly at launch time with a null state.
 * - `"drafting"` — written by PlansService.prepare
 * - `"ready"` — written by PlansService.approve
 */
export type PlanState = "drafting" | "ready" | null;

/**
 * Full plan metadata shape written to `plans/<slug>/metadata.json`.
 *
 * Introduced in ADR 014 step 4 (issue #154). Earlier steps wrote only a
 * 3-field marker (`plan_id`, `work_item_id`, `created_at`); `readPlanMetadata`
 * tolerates that legacy shape by filling in missing fields with defaults.
 */
export interface PlanMetadata {
  plan_id: string;
  work_item_id: string;
  created_at: string;
  updated_at: string;
  state: PlanState;
  scratchpad_path: string;
  approved_at: string | null;
  approved_by: string | null;
  run_ids: string[];
}

/** Path to the metadata.json sidecar for a work item's plan. */
export function planMetadataPath(artifactRoot: string, workItemId: string): string {
  return join(planDir(artifactRoot, workItemId), PLAN_METADATA_FILE);
}

/**
 * Read plan metadata from disk, tolerating the legacy 3-field marker shape.
 * Returns `null` if the metadata file does not exist.
 *
 * Missing fields are filled with safe defaults: `state` is `null`,
 * `updated_at` falls back to `created_at`, `scratchpad_path` is recomputed,
 * approver fields are null, `run_ids` is empty. This lets new code assume the
 * full shape without breaking plan dirs created by earlier steps.
 *
 * @throws if the file exists but cannot be parsed as JSON
 */
export function readPlanMetadata(artifactRoot: string, workItemId: string): PlanMetadata | null {
  const path = planMetadataPath(artifactRoot, workItemId);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `readPlanMetadata: failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!raw || typeof raw !== "object") {
    throw new Error(`readPlanMetadata: ${path} did not contain a JSON object`);
  }

  const partial = raw as Partial<PlanMetadata>;
  const slug = workItemSlug(workItemId);
  const createdAt = typeof partial.created_at === "string" ? partial.created_at : new Date(0).toISOString();

  return {
    plan_id: typeof partial.plan_id === "string" ? partial.plan_id : slug,
    work_item_id: typeof partial.work_item_id === "string" ? partial.work_item_id : workItemId,
    created_at: createdAt,
    updated_at: typeof partial.updated_at === "string" ? partial.updated_at : createdAt,
    state: partial.state === "drafting" || partial.state === "ready" ? partial.state : null,
    scratchpad_path:
      typeof partial.scratchpad_path === "string"
        ? partial.scratchpad_path
        : canonicalScratchpadPath(artifactRoot, workItemId),
    approved_at: typeof partial.approved_at === "string" ? partial.approved_at : null,
    approved_by: typeof partial.approved_by === "string" ? partial.approved_by : null,
    run_ids: Array.isArray(partial.run_ids)
      ? partial.run_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * Write plan metadata to disk. Caller is responsible for ensuring the plan
 * dir exists (use `ensurePlanDir` first).
 */
export function writePlanMetadata(
  artifactRoot: string,
  workItemId: string,
  metadata: PlanMetadata,
): void {
  const path = planMetadataPath(artifactRoot, workItemId);
  writeFileSync(path, JSON.stringify(metadata, null, 2), "utf8");
}

/* ── Plan dir creation with collision detection ──────────────────────────── */

/**
 * Ensure the plan directory for a work item exists, creating it (and a full
 * metadata sidecar) on first call. Idempotent when called repeatedly for the
 * same work item id.
 *
 * Detects slug collisions: if another work item id already owns a plan dir at
 * the same slug path, throws with a clear error. This matches the collision
 * detection requirement in ADR 014 step 1.
 *
 * On first creation, writes the full `PlanMetadata` shape with `state: null`,
 * `updated_at = created_at`, empty approver fields, and empty `run_ids`.
 * PlansService.prepare overwrites with `state: "drafting"` afterwards.
 *
 * Returns the absolute path to the plan directory.
 *
 * @throws if a different work item id already owns the slug
 */
export function ensurePlanDir(artifactRoot: string, workItemId: string): string {
  const slug = workItemSlug(workItemId);
  const dir = join(plansRoot(artifactRoot), slug);
  const metadataPath = join(dir, PLAN_METADATA_FILE);

  if (existsSync(metadataPath)) {
    let existing: Partial<PlanMetadata> | null = null;
    try {
      existing = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<PlanMetadata>;
    } catch {
      // Corrupt marker — treat as a collision the caller must resolve manually.
      throw new Error(
        `ensurePlanDir: existing plan metadata at ${metadataPath} could not be parsed; refusing to overwrite`,
      );
    }

    if (existing?.work_item_id && existing.work_item_id !== workItemId) {
      throw new Error(
        `ensurePlanDir: slug collision — work item ${JSON.stringify(workItemId)} normalizes to ${JSON.stringify(slug)}, ` +
          `but that slug is already owned by ${JSON.stringify(existing.work_item_id)}`,
      );
    }

    // Same work item id — idempotent no-op.
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const metadata: PlanMetadata = {
    plan_id: slug,
    work_item_id: workItemId,
    created_at: now,
    updated_at: now,
    state: null,
    scratchpad_path: canonicalScratchpadPath(artifactRoot, workItemId),
    approved_at: null,
    approved_by: null,
    run_ids: [],
  };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return dir;
}
