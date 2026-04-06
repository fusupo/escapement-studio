import { describe, it, expect } from "vitest";
import { parseChangedFilePath } from "../execution.service.js";

describe("parseChangedFilePath", () => {
  it("parses a modified file", () => {
    expect(parseChangedFilePath(" M src/main.ts")).toBe("src/main.ts");
  });

  it("parses a modified file with web/ prefix", () => {
    expect(parseChangedFilePath(" M web/src/app.css")).toBe("web/src/app.css");
  });

  it("parses an added file", () => {
    expect(parseChangedFilePath("A  docs/new.md")).toBe("docs/new.md");
  });

  it("parses an untracked file", () => {
    expect(parseChangedFilePath("?? untracked.txt")).toBe("untracked.txt");
  });

  it("parses a renamed file and returns the new path", () => {
    expect(parseChangedFilePath("R  old/path.ts -> new/path.ts")).toBe("new/path.ts");
  });

  it("parses a renamed file with spaces in status columns", () => {
    expect(parseChangedFilePath("RM old/file.ts -> src/modules/new-file.ts")).toBe("src/modules/new-file.ts");
  });

  it("returns null for empty string", () => {
    expect(parseChangedFilePath("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseChangedFilePath("   ")).toBeNull();
  });

  it("preserves full path — does not truncate leading characters", () => {
    // This is the regression that caused the eb/src/... bug
    const result = parseChangedFilePath(" M web/src/components/App.svelte");
    expect(result).toBe("web/src/components/App.svelte");
    expect(result).not.toMatch(/^eb\//);
  });

  it("handles deleted file", () => {
    expect(parseChangedFilePath(" D src/old-file.ts")).toBe("src/old-file.ts");
  });

  it("handles double-status indicators", () => {
    expect(parseChangedFilePath("MM src/changed-twice.ts")).toBe("src/changed-twice.ts");
  });
});
