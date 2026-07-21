import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: sessionMocks.createAgentSession,
  SessionManager: { inMemory: vi.fn(() => ({})) },
}));

import { SubAgentService } from "../sub-agent.service.js";

function makeSession(sessionId: string, response: string, promptError?: Error) {
  return {
    sessionId,
    subscribe: vi.fn(() => vi.fn()),
    prompt: promptError ? vi.fn().mockRejectedValue(promptError) : vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn(() => response),
  };
}

describe("SubAgentService", () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = mkdtempSync(join(tmpdir(), "studio-subagent-"));
    process.env.ARTIFACT_ROOT = artifactRoot;
    sessionMocks.createAgentSession.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ARTIFACT_ROOT;
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  it("creates distinct run IDs and artifacts for concurrent delegations at the same timestamp", async () => {
    const completedSession = makeSession("session-completed", JSON.stringify({
      run_id: "untrusted-model-id",
      agent_type: "scope-predictor",
      status: "completed",
      summary: "Found the implementation path.",
      confidence: "high",
      findings: [],
    }));
    const failedSession = makeSession("session-failed", "", new Error("session failed"));
    sessionMocks.createAgentSession
      .mockResolvedValueOnce({ session: completedSession })
      .mockResolvedValueOnce({ session: failedSession });

    const service = new SubAgentService({ getSelectedModel: vi.fn() } as never);
    const [completed, failed] = await Promise.all([
      service.runDelegation({ agent_type: "code-crawler", task: "Trace code" }),
      service.runDelegation({ agent_type: "scope-predictor", task: "Predict scope" }),
    ]);

    expect(completed.run_id).toMatch(/^sub_1700000000000_[0-9a-f-]{36}$/);
    expect(failed.run_id).toMatch(/^sub_1700000000000_[0-9a-f-]{36}$/);
    expect(completed.run_id).not.toBe(failed.run_id);
    expect(completed.artifact_dir).not.toBe(failed.artifact_dir);
    expect(existsSync(join(completed.artifact_dir, "metadata.json"))).toBe(true);
    expect(existsSync(join(failed.artifact_dir, "metadata.json"))).toBe(true);

    expect(completed.status).toBe("completed");
    expect(completed.result?.run_id).toBe(completed.run_id);
    expect(completed.result?.agent_type).toBe("code-crawler");
    expect(failed.status).toBe("error");
    expect(failed.result?.run_id).toBe(failed.run_id);

    const completedStatus = JSON.parse(readFileSync(join(completed.artifact_dir, "status.json"), "utf8"));
    const failedStatus = JSON.parse(readFileSync(join(failed.artifact_dir, "status.json"), "utf8"));
    expect(completedStatus.result.run_id).toBe(completed.run_id);
    expect(failedStatus.result.run_id).toBe(failed.run_id);
  });
});
