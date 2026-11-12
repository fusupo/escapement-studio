/** API refresh context only: subscribers must establish their own git freshness. */
export class GitHubRepoTruthRefreshedEvent {
  constructor(public readonly repo: string, public readonly refreshedAt: number) {}
}

/** Canonical GitHub identity; do not accept arbitrary hosts or URL suffixes. */
export function normalizeGitHubRepo(input: string | null | undefined): string | null {
  const value = input?.trim().replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i, "")
    .replace(/\/$/, "").replace(/\.git$/i, "");
  return value && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/i.test(value)
    && !value.endsWith("/.") && !value.endsWith("/..") ? value.toLowerCase() : null;
}
