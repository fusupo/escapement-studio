import { describe, expect, it } from "vitest";
import type { FollowUpMessageDto, FollowUpMessageResult, RunChatHistory, RunChatMessage } from "../types.js";

describe("follow-up types", () => {
  it("FollowUpMessageDto accepts minimal input", () => {
    const dto: FollowUpMessageDto = {
      run_id: "exec_123",
      message: "Please also add tests",
    };
    expect(dto.run_id).toBe("exec_123");
    expect(dto.message).toBe("Please also add tests");
    expect(dto.delivery).toBeUndefined();
  });

  it("FollowUpMessageDto accepts delivery mode", () => {
    const dto: FollowUpMessageDto = {
      run_id: "exec_123",
      message: "Stop and fix the lint errors",
      delivery: "steer",
    };
    expect(dto.delivery).toBe("steer");
  });

  it("FollowUpMessageResult represents accepted follow-up", () => {
    const result: FollowUpMessageResult = {
      accepted: true,
      run_id: "exec_123",
      delivery: "followUp",
      message: "Please also add tests",
    };
    expect(result.accepted).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("FollowUpMessageResult represents rejected follow-up", () => {
    const result: FollowUpMessageResult = {
      accepted: false,
      run_id: "exec_123",
      delivery: "followUp",
      message: "test",
      error: "Run is in blocked status",
    };
    expect(result.accepted).toBe(false);
    expect(result.error).toBe("Run is in blocked status");
  });

  it("RunChatHistory models conversation", () => {
    const messages: RunChatMessage[] = [
      { timestamp: "2026-04-06T10:00:00Z", role: "assistant", text: "Done implementing the feature." },
      { timestamp: "2026-04-06T10:01:00Z", role: "user", text: "Also add unit tests please." },
      { timestamp: "2026-04-06T10:02:00Z", role: "assistant", text: "Added 3 test cases." },
    ];
    const history: RunChatHistory = {
      run_id: "exec_456",
      messages,
    };
    expect(history.messages).toHaveLength(3);
    expect(history.messages[0].role).toBe("assistant");
    expect(history.messages[1].role).toBe("user");
  });
});
