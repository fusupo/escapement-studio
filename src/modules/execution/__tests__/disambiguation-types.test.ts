import { describe, expect, it } from "vitest";
import type {
  ExecutionRunStatus,
  LaunchExecutionRunDto,
  ResolveDisambiguationDto,
  ResolveDisambiguationResult,
} from "../types.js";

describe("disambiguation types", () => {
  it("ExecutionRunStatus includes disambiguating", () => {
    const status: ExecutionRunStatus = "disambiguating";
    expect(status).toBe("disambiguating");
  });

  it("LaunchExecutionRunDto accepts disambiguate flag", () => {
    const dto: LaunchExecutionRunDto = {
      work_item_id: "studio-96",
      disambiguate: true,
    };
    expect(dto.disambiguate).toBe(true);
  });

  it("LaunchExecutionRunDto disambiguate is optional — refinement is mandatory when omitted", () => {
    const dto: LaunchExecutionRunDto = {
      work_item_id: "studio-96",
    };
    // The field is deprecated; launch always enters refinement.
    expect(dto.disambiguate).toBeUndefined();
    expect(dto.disambiguate !== false).toBe(true);
  });

  it("ResolveDisambiguationDto accepts minimal input", () => {
    const dto: ResolveDisambiguationDto = {
      run_id: "exec_123",
    };
    expect(dto.run_id).toBe("exec_123");
    expect(dto.additional_context).toBeUndefined();
  });

  it("ResolveDisambiguationDto accepts additional_context", () => {
    const dto: ResolveDisambiguationDto = {
      run_id: "exec_123",
      additional_context: "Use the existing validation module rather than creating a new one.",
    };
    expect(dto.additional_context).toContain("validation module");
  });

  it("ResolveDisambiguationResult represents successful resolution", () => {
    const result: ResolveDisambiguationResult = {
      resolved: true,
      run_id: "exec_123",
    };
    expect(result.resolved).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("ResolveDisambiguationResult represents failed resolution", () => {
    const result: ResolveDisambiguationResult = {
      resolved: false,
      run_id: "exec_123",
      error: "Run is in \"running\" status; only runs in \"disambiguating\" status can be resolved.",
    };
    expect(result.resolved).toBe(false);
    expect(result.error).toContain("disambiguating");
  });
});
