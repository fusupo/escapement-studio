const CATEGORIES = new Set(["implementation", "acceptance", "verification"]);

export function isValidChecklistSnapshot(snapshot, expectedRunId) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  if (typeof expectedRunId !== "string" || snapshot.run_id !== expectedRunId) return false;
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) return false;
  if (snapshot.revision === 0) {
    if (snapshot.updated_at !== null) return false;
  } else if (typeof snapshot.updated_at !== "string" || Number.isNaN(Date.parse(snapshot.updated_at))) {
    return false;
  }
  if (!Array.isArray(snapshot.items)) return false;
  if (!Number.isInteger(snapshot.completed) || snapshot.completed < 0) return false;
  if (!Number.isInteger(snapshot.total) || snapshot.total < 0) return false;

  const validItems = snapshot.items.every((item) => item
    && typeof item === "object"
    && typeof item.text === "string"
    && item.text.trim().length > 0
    && typeof item.checked === "boolean"
    && CATEGORIES.has(item.category));
  if (!validItems) return false;

  const implementation = snapshot.items.filter((item) => item.category === "implementation");
  return snapshot.total === implementation.length
    && snapshot.completed === implementation.filter((item) => item.checked).length;
}

export function shouldReplaceChecklistSnapshot(current, incoming, expectedRunId) {
  if (!isValidChecklistSnapshot(incoming, expectedRunId)) return false;
  if (!isValidChecklistSnapshot(current, expectedRunId)) return true;
  return incoming.revision > current.revision;
}

export function mergeChecklistSnapshot(current, incoming, expectedRunId) {
  return shouldReplaceChecklistSnapshot(current, incoming, expectedRunId) ? incoming : current;
}
