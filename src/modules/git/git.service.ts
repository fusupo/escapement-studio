import { BadRequestException, Injectable } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ArtifactRootSource = "AGENTS.md" | "CLAUDE.md" | null;

export interface RepoArtifactRootSuggestion {
  artifact_root: string | null;
  source: ArtifactRootSource;
}

export interface DiscoveredRepoConfig {
  repo: string;
  local_path: string;
  remote: string;
  artifact_root_suggestion: string | null;
  artifact_root_source: ArtifactRootSource;
}

@Injectable()
export class GitService {
  discoverRepo(inputPath: string): DiscoveredRepoConfig {
    const normalizedInput = inputPath?.trim();
    if (!normalizedInput) {
      throw new BadRequestException("path is required");
    }

    const requestedPath = resolve(expandUserPath(normalizedInput));
    const repoRoot = this.resolveGitRoot(requestedPath);
    const remote = this.readOriginRemote(repoRoot);
    const repo = parseGitHubRepoSlug(remote);

    if (!repo) {
      throw new BadRequestException(`Could not derive GitHub owner/repo from origin remote: ${remote}`);
    }

    const artifactSuggestion = this.suggestArtifactRoot(repoRoot);

    return {
      repo,
      local_path: repoRoot,
      remote,
      artifact_root_suggestion: artifactSuggestion.artifact_root,
      artifact_root_source: artifactSuggestion.source,
    };
  }

  suggestArtifactRoot(repoRoot: string): RepoArtifactRootSuggestion {
    for (const fileName of ["AGENTS.md", "CLAUDE.md"] as const) {
      const filePath = join(repoRoot, fileName);
      if (!existsSync(filePath)) {
        continue;
      }

      const parsed = parseContextPathFile(filePath);
      if (parsed) {
        return {
          artifact_root: resolveConfiguredPath(repoRoot, parsed),
          source: fileName,
        };
      }
    }

    return { artifact_root: null, source: null };
  }

  private resolveGitRoot(inputPath: string): string {
    try {
      const output = execFileSync("git", ["-C", inputPath, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return resolve(output);
    } catch {
      throw new BadRequestException(`Not a git repository: ${inputPath}`);
    }
  }

  private readOriginRemote(repoRoot: string): string {
    try {
      return execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new BadRequestException(`Git repository at ${repoRoot} does not have an origin remote`);
    }
  }
}

export function parseGitHubRepoSlug(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) {
    return null;
  }

  const scpLike = trimmed.match(/^(?:.+@)?github\.com:(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/i);
  if (scpLike?.groups?.owner && scpLike.groups.repo) {
    return `${scpLike.groups.owner}/${scpLike.groups.repo}`;
  }

  try {
    const url = new URL(trimmed);
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) {
      return null;
    }

    const [owner, repoCandidate] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repoCandidate) {
      return null;
    }

    const repo = repoCandidate.replace(/\.git$/i, "");
    return repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

export function parseContextPath(content: string): string | null {
  const match = content.match(/\*\*context-path\*\*:\s*(.+)/i);
  if (!match?.[1]) {
    return null;
  }

  return sanitizeConfiguredPath(match[1]);
}

export function parseContextPathFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    return parseContextPath(content);
  } catch {
    return null;
  }
}

export function sanitizeConfiguredPath(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").replace(/^['\"]+|['\"]+$/g, "").trim();
}

export function expandUserPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveConfiguredPath(baseDir: string, configuredPath: string): string {
  const expanded = expandUserPath(configuredPath);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}
