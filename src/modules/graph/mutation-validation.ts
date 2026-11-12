import type { GraphMutationError } from "./types.js";

type Validator = (value: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text: Validator = (v) => typeof v === "string" && v.trim().length > 0;
const nullableText: Validator = (v) => v === null || typeof v === "string";
const oneOf = (...values: string[]): Validator => (v) => typeof v === "string" && values.includes(v);
const strings: Validator = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");
const positiveInteger: Validator = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const workItemFields: Record<string, Validator> = {
  name: text,
  kind: oneOf("issue", "capability", "phase", "track"),
  state: oneOf("planned", "drafting", "ready", "in_progress", "run_errored", "open_pr", "merged_pr", "closed", "deferred", "done", "archived", "cancelled", "pre_pr.planned", "pre_pr.drafting", "pre_pr.ready", "pre_pr.in_progress", "pre_pr.run_errored"),
  repo: nullableText, issue_number: (v) => v === null || positiveInteger(v),
  issue_url: nullableText, scope_hint: nullableText, branch: nullableText, archive_path: nullableText,
  predicted_files: strings, actual_files: strings, meta: object,
};
const edgeFields: Record<string, Validator> = {
  confidence: oneOf("certain", "inferred", "ambiguous"), meta: object,
};

function fields(value: unknown, validators: Record<string, Validator>, required: string[] = []): string | null {
  if (!object(value)) return "must be an object";
  for (const key of required) if (!Object.hasOwn(value, key)) return `requires ${key}`;
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(validators, key)) return `unknown or immutable field: ${key}`;
    // Internal callers may supply omitted optional DTO properties as undefined.
    if (v === undefined && !required.includes(key)) continue;
    if (!validators[key](v)) return `invalid ${key}`;
  }
  return null;
}

/** Validate before sorting, snapshot simulation or SQL construction. HTTP DTO types
 * disappear at runtime; this boundary also protects internal graph writers. */
export function validateMutationInput(input: unknown): GraphMutationError[] {
  const errors: GraphMutationError[] = [];
  const fail = (message: string, mutation: unknown = null) => {
    errors.push({ code: "malformed_payload", message, mutation_id: object(mutation) && typeof mutation.mutation_id === "string" ? mutation.mutation_id : null });
  };
  const envelopeError = fields(input, {
    proposal_id: text, based_on_graph_version: text, mutations: Array.isArray,
  }, ["mutations"]);
  if (envelopeError) { fail(`Graph request ${envelopeError}`); return errors; }
  const mutations = (input as { mutations: unknown[] }).mutations;
  if (!mutations.length) { fail("mutations must contain at least one mutation"); return errors; }
  for (const mutation of mutations) {
    if (!object(mutation)) { fail("Mutation must be an object"); continue; }
    let error: string | null;
    const base = { mutation_id: text, kind: text };
    switch (mutation.kind) {
      case "create_work_item":
        error = fields(mutation, { ...base, work_item: object }, ["work_item"])
          ?? fields(mutation.work_item, { id: text, ...workItemFields }, ["id", "name", "kind"]);
        break;
      case "update_work_item":
        error = fields(mutation, { ...base, id: text, patch: object }, ["id", "patch"])
          ?? fields(mutation.patch, workItemFields);
        break;
      case "create_edge":
        error = fields(mutation, { ...base, edge: object }, ["edge"])
          ?? fields(mutation.edge, { ...edgeFields, from_id: text, to_id: text, rel: oneOf("depends_on", "is_part_of", "implemented_by") }, ["from_id", "to_id", "rel"]);
        break;
      case "update_edge":
        error = fields(mutation, { ...base, id: positiveInteger, patch: object }, ["id", "patch"])
          ?? fields(mutation.patch, edgeFields);
        break;
      case "delete_work_item":
      case "delete_edge":
        error = fields(mutation, { ...base, id: mutation.kind === "delete_edge" ? positiveInteger : text }, ["id"]);
        break;
      default: error = "unknown mutation kind";
    }
    if (error) fail(`${String(mutation.kind)} ${error}`, mutation);
  }
  return errors;
}
