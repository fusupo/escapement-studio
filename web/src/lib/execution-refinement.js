export function refinementResponseKey(runId, itemId) {
  return `${runId}:${itemId}`;
}

export function refinementResponseFor(run, item, responses) {
  return responses[refinementResponseKey(run.run_id, item.id)] ?? item.response ?? "";
}

export function unresolvedRefinementItems(run, responses) {
  return (run.refinement?.items || []).filter(
    (item) => !refinementResponseFor(run, item, responses).trim(),
  );
}
