export function selectPullRequest(item) {
  const candidates = [
    item?.meta?.studio_post_merge_sync?.pull_request,
    item?.pull_request,
    item?.meta?.pull_request,
  ].filter((candidate) => candidate && typeof candidate === "object");

  // A stale PR-open snapshot can coexist with the post-merge HSM stamp.
  // Confirmed merge truth must win regardless of which projection supplied it.
  return candidates.find((candidate) => candidate.merged_at) ?? candidates[0] ?? null;
}
