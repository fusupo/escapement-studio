export function refinementResponseKey(runId, itemId) {
  return `${runId}:${itemId}`;
}

function optionFor(item, optionId) {
  return item.options?.find((option) => option.id === optionId);
}

function canonicalOptionResponse(option) {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

export function coerceRefinementDraft(item, value) {
  if (typeof value === "string") {
    if (!item.options) return { mode: "legacy", selected_option_id: null, text: value };
    if (item.allow_other) return { mode: "other", selected_option_id: null, text: value };
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const text = typeof value.text === "string" ? value.text : "";
  if (value.mode === "legacy" && !item.options) {
    return { mode: "legacy", selected_option_id: null, text };
  }
  if (value.mode === "other" && item.options && item.allow_other) {
    return { mode: "other", selected_option_id: null, text };
  }
  if (value.mode === "option" && item.options) {
    const selected = typeof value.selected_option_id === "string"
      && optionFor(item, value.selected_option_id)
      ? value.selected_option_id
      : null;
    return { mode: "option", selected_option_id: selected, text: "" };
  }
  return null;
}

export function seedRefinementDraft(item) {
  if (!item.options) {
    return { mode: "legacy", selected_option_id: null, text: item.response || "" };
  }
  if (item.selected_option_id && optionFor(item, item.selected_option_id)) {
    return { mode: "option", selected_option_id: item.selected_option_id, text: "" };
  }
  if (item.allow_other && item.response) {
    return { mode: "other", selected_option_id: null, text: item.response };
  }
  return { mode: "option", selected_option_id: null, text: "" };
}

export function refinementDraftFor(run, item, drafts) {
  const key = refinementResponseKey(run.run_id, item.id);
  if (Object.prototype.hasOwnProperty.call(drafts, key)) {
    const local = coerceRefinementDraft(item, drafts[key]);
    if (local) return local;
  }
  return seedRefinementDraft(item);
}

// Compatibility projection for callers that only need the current text.
export function refinementResponseFor(run, item, drafts) {
  const draft = refinementDraftFor(run, item, drafts);
  if (draft.mode === "option") {
    const option = optionFor(item, draft.selected_option_id);
    return option ? canonicalOptionResponse(option) : "";
  }
  return draft.text;
}

export function selectRefinementOption(item, draft, optionId) {
  if (!item.options || !optionFor(item, optionId)) return coerceRefinementDraft(item, draft) ?? seedRefinementDraft(item);
  return { mode: "option", selected_option_id: optionId, text: "" };
}

export function selectRefinementOther(item, draft) {
  if (!item.options || !item.allow_other) return coerceRefinementDraft(item, draft) ?? seedRefinementDraft(item);
  const current = coerceRefinementDraft(item, draft);
  return {
    mode: "other",
    selected_option_id: null,
    text: current?.mode === "other" ? current.text : "",
  };
}

export function updateRefinementOther(item, draft, text) {
  if (!item.options || !item.allow_other) return coerceRefinementDraft(item, draft) ?? seedRefinementDraft(item);
  return { mode: "other", selected_option_id: null, text };
}

export function updateLegacyRefinement(item, text) {
  if (item.options) return seedRefinementDraft(item);
  return { mode: "legacy", selected_option_id: null, text };
}

export function isRefinementDraftAnswered(item, draft) {
  const value = coerceRefinementDraft(item, draft);
  if (!value) return false;
  if (value.mode === "option") return Boolean(optionFor(item, value.selected_option_id));
  return Boolean(value.text.trim());
}

export function unresolvedRefinementItems(run, drafts) {
  return (run.refinement?.items || []).filter((item) => (
    !isRefinementDraftAnswered(item, refinementDraftFor(run, item, drafts))
  ));
}

export function hasCancellationSelection(run, drafts) {
  return (run.refinement?.items || []).some((item) => {
    const draft = refinementDraftFor(run, item, drafts);
    if (draft.mode !== "option") return false;
    return optionFor(item, draft.selected_option_id)?.action === "cancel_execution";
  });
}

export function projectRefinementResponses(run, drafts) {
  return (run.refinement?.items || []).flatMap((item) => {
    const draft = refinementDraftFor(run, item, drafts);
    if (!isRefinementDraftAnswered(item, draft)) return [];
    if (draft.mode === "option") {
      const option = optionFor(item, draft.selected_option_id);
      return [{
        item_id: item.id,
        selected_option_id: option.id,
        response: canonicalOptionResponse(option),
      }];
    }
    return [{ item_id: item.id, response: draft.text.trim() }];
  });
}
