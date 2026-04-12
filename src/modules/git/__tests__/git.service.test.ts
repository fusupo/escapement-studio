import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import {
  GitService,
  expandUserPath,
  parseContextPath,
  parseGitHubRepoSlug,
  resolveConfiguredPath,
} from "../git.service.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "studio-git-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initRepo(remote = "git@github.com:fusupo/escapement-studio.git"): string {
  const dir = makeTempDir();
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseGitHubRepoSlug", () => {
  it("parses SSH remotes", () => {
    expect(parseGitHubRepoSlug("git@github.com:fusupo/escapement-studio.git")).toBe("fusupo/escapement-studio");
  });

  it("parses HTTPS remotes", () => {
    expect(parseGitHubRepoSlug("https://github.com/fusupo/escapement-studio.git")).toBe("fusupo/escapement-studio");
  });

  it("parses SSH URL remotes", () => {
    expect(parseGitHubRepoSlug("ssh://git@github.com/fusupo/escapement-studio.git")).toBe("fusupo/escapement-studio");
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRepoSlug("git@gitlab.com:fusupo/escapement-studio.git")).toBeNull();
  });
});

describe("parseContextPath", () => {
  it("reads markdown context-path definitions", () => {
    expect(parseContextPath("**context-path**: ../escapement-studio-ctx")).toBe("../escapement-studio-ctx");
  });

  it("strips wrapping quotes and backticks", () => {
    expect(parseContextPath("**context-path**: `~/escapement-studio-ctx`\n")).toBe("~/escapement-studio-ctx");
  });

  it("returns null when not present", () => {
    expect(parseContextPath("No context path here")).toBeNull();
  });
});

describe("path helpers", () => {
  it("expands tilde to the home directory", () => {
    expect(expandUserPath("~/studio-ctx")).toMatch(/studio-ctx$/);
    expect(expandUserPath("~/studio-ctx")).not.toContain("~");
  });

  it("resolves relative configured paths against the repo root", () => {
    expect(resolveConfiguredPath("/tmp/repo", "../repo-ctx")).toBe("/tmp/repo-ctx");
  });
});

describe("GitService.discoverRepo", () => {
  it("discovers repo metadata from a git checkout", () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "AGENTS.md"), "# Project\n\n**context-path**: ../escapement-studio-ctx\n", "utf8");

    const service = new GitService();
    (service as unknown as { resolveGitRoot: (path: string) => string }).resolveGitRoot = (inputPath: string) => {
      expect(inputPath).toBe(repoDir);
      return repoDir;
    };
    (service as unknown as { readOriginRemote: (path: string) => string }).readOriginRemote = (repoRoot: string) => {
      expect(repoRoot).toBe(repoDir);
      return "git@github.com:fusupo/escapement-studio.git";
    };
    const result = service.discoverRepo(repoDir);

    expect(result).toEqual({
      repo: "fusupo/escapement-studio",
      local_path: repoDir,
      remote: "git@github.com:fusupo/escapement-studio.git",
      artifact_root_suggestion: join(repoDir, "..", "escapement-studio-ctx"),
      artifact_root_source: "AGENTS.md",
    });
  });

  it("normalizes a nested path back to the repo root", () => {
    const repoDir = initRepo("https://github.com/fusupo/escapement-studio.git");
    mkdirSync(join(repoDir, "nested", "deep"), { recursive: true });

    const service = new GitService();
    (service as unknown as { resolveGitRoot: (path: string) => string }).resolveGitRoot = (inputPath: string) => {
      expect(inputPath).toBe(join(repoDir, "nested", "deep"));
      return repoDir;
    };
    (service as unknown as { readOriginRemote: (path: string) => string }).readOriginRemote = () =>
      "https://github.com/fusupo/escapement-studio.git";
    const result = service.discoverRepo(join(repoDir, "nested", "deep"));

    expect(result.local_path).toBe(repoDir);
    expect(result.repo).toBe("fusupo/escapement-studio");
  });

  it("throws when the directory is not a git repo", () => {
    const service = new GitService();
    const dir = makeTempDir();
    (service as unknown as { resolveGitRoot: (path: string) => string }).resolveGitRoot = () => {
      throw new BadRequestException(`Not a git repository: ${dir}`);
    };

    expect(() => service.discoverRepo(dir)).toThrowError(BadRequestException);
  });

  it("throws when origin is missing", () => {
    const dir = makeTempDir();

    const service = new GitService();
    (service as unknown as { resolveGitRoot: (path: string) => string }).resolveGitRoot = () => dir;
    (service as unknown as { readOriginRemote: (path: string) => string }).readOriginRemote = () => {
      throw new BadRequestException(`Git repository at ${dir} does not have an origin remote`);
    };
    expect(() => service.discoverRepo(dir)).toThrowError(/origin remote/);
  });
});
