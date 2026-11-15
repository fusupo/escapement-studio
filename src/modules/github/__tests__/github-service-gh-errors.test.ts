import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/gh-runner.js", () => ({ runGh }));

import { GitHubService } from "../github.service.js";

describe("GitHubService gh failures", () => {
  const service = () => new GitHubService({} as any, {} as any, {} as any);

  it("surfaces a gh timeout as a request error instead of hanging", async () => {
    runGh.mockRejectedValueOnce(new Error("gh command timed out after 30000ms"));
    const error = await service().readIssue("fusupo/escapement-studio", 290).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe("gh command failed: gh command timed out after 30000ms");
  });

  it("passes arguments and stdin to the shared runner", async () => {
    runGh.mockResolvedValueOnce("https://github.com/fusupo/escapement-studio/issues/7\n");
    await (service() as any).runGh(["issue", "edit", "7", "--body-file", "-"], "new body");
    expect(runGh).toHaveBeenLastCalledWith(["issue", "edit", "7", "--body-file", "-"], { stdin: "new body" });
  });
});
