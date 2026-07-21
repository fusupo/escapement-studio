import type {
  ExecutionRefinementItem,
  ExecutionRefinementItemKind,
  ExecutionRefinementOption,
} from "./types.js";

export interface SanitizedRefinementMetadata {
  options: ExecutionRefinementOption[];
  recommended_option_id?: string;
  allow_other?: boolean;
}

export type NormalizedRefinementResponse =
  | { ok: true; selected_option_id: string | null; response: string }
  | { ok: false; error: string };

function trimmedNonblank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Validate optional choice metadata as one unit. Invalid metadata degrades to legacy. */
export function sanitizeRefinementMetadata(
  raw: unknown,
  kind: ExecutionRefinementItemKind,
): SanitizedRefinementMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) return null;
  if (value.allow_other !== undefined && typeof value.allow_other !== "boolean") return null;

  const ids = new Set<string>();
  const options: ExecutionRefinementOption[] = [];
  for (const candidate of value.options) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const option = candidate as Record<string, unknown>;
    const id = trimmedNonblank(option.id);
    const label = trimmedNonblank(option.label);
    if (!id || !label || ids.has(id)) return null;
    if (option.description !== undefined && !trimmedNonblank(option.description)) return null;
    if (option.action !== undefined && option.action !== "cancel_execution") return null;
    if (option.action === "cancel_execution" && kind !== "blocker") return null;

    ids.add(id);
    options.push({
      id,
      label,
      ...(option.description === undefined ? {} : { description: trimmedNonblank(option.description)! }),
      ...(option.action === "cancel_execution" ? { action: option.action } : {}),
    });
  }

  const recommended = trimmedNonblank(value.recommended_option_id);
  return {
    options,
    ...(recommended && ids.has(recommended) ? { recommended_option_id: recommended } : {}),
    ...(value.allow_other === undefined ? {} : { allow_other: value.allow_other }),
  };
}

export function canonicalOptionResponse(option: ExecutionRefinementOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

export function findSelectedRefinementOption(
  item: ExecutionRefinementItem,
): ExecutionRefinementOption | undefined {
  if (!item.selected_option_id) return undefined;
  return item.options?.find((option) => option.id === item.selected_option_id);
}

export function isCancellationSelection(item: ExecutionRefinementItem): boolean {
  return findSelectedRefinementOption(item)?.action === "cancel_execution";
}

export function sanitizeRehydratedRefinementAnswer(
  item: ExecutionRefinementItem,
): Pick<ExecutionRefinementItem, "selected_option_id" | "response"> {
  const response = trimmedNonblank(item.response);
  if (!item.options) {
    return { selected_option_id: null, response };
  }

  const selected = item.selected_option_id
    ? item.options.find((option) => option.id === item.selected_option_id)
    : undefined;
  if (selected) {
    return {
      selected_option_id: selected.id,
      response: canonicalOptionResponse(selected),
    };
  }
  return {
    selected_option_id: null,
    response: item.allow_other ? response : null,
  };
}

export function isRefinementItemAnswered(item: ExecutionRefinementItem): boolean {
  const normalized = sanitizeRehydratedRefinementAnswer(item);
  return Boolean(normalized.response);
}

export function normalizeSubmittedRefinementResponse(
  item: ExecutionRefinementItem,
  raw: unknown,
): NormalizedRefinementResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `Response for ${item.id} must be an object.` };
  }
  const value = raw as Record<string, unknown>;
  const selectedId = value.selected_option_id === undefined
    ? null
    : trimmedNonblank(value.selected_option_id);
  const response = trimmedNonblank(value.response);

  if (value.selected_option_id !== undefined && !selectedId) {
    return { ok: false, error: `Response for ${item.id} has a blank selected_option_id.` };
  }

  if (!item.options) {
    if (selectedId) return { ok: false, error: `Legacy item ${item.id} does not accept an option ID.` };
    if (!response) return { ok: false, error: `Response for ${item.id} cannot be blank.` };
    return { ok: true, selected_option_id: null, response };
  }

  if (selectedId) {
    const option = item.options.find((candidate) => candidate.id === selectedId);
    if (!option) return { ok: false, error: `Unknown option "${selectedId}" for ${item.id}.` };
    return {
      ok: true,
      selected_option_id: option.id,
      response: canonicalOptionResponse(option),
    };
  }

  if (!item.allow_other) {
    return { ok: false, error: `Item ${item.id} does not allow a custom response.` };
  }
  if (!response) return { ok: false, error: `Custom response for ${item.id} cannot be blank.` };
  return { ok: true, selected_option_id: null, response };
}
