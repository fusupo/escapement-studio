const FALLBACK_WORKING_BRANCH = "main";

const DEFAULT_WORKING_BRANCH_BY_REPO: Record<string, string> = {
  "fusupo/escapement-studio": "develop",
};

export function getDefaultWorkingBranch(repo?: string | null): string {
  if (!repo) {
    return FALLBACK_WORKING_BRANCH;
  }

  return DEFAULT_WORKING_BRANCH_BY_REPO[repo] ?? FALLBACK_WORKING_BRANCH;
}

export function listDefaultWorkingBranches(): Record<string, string> {
  return { ...DEFAULT_WORKING_BRANCH_BY_REPO };
}
