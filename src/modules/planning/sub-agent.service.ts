import { Injectable, Inject, Logger } from "@nestjs/common";
import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { runDir } from "../../lib/context-layout.js";
import type {
  DelegateSubAgentToolInput,
  SubAgentResultEnvelope,
  SubAgentRunRecord,
  SubAgentRunStatus,
  SubAgentType,
} from "./types.js";
import { SettingsService } from "../settings/settings.service.js";

interface RunHooks {
  onStatus?: (run: SubAgentRunRecord) => void;
  onResult?: (run: SubAgentRunRecord) => void;
}

/**
 * Phase 9b audit (#241): this service's private `upsertRecentRun` /
 * `writeMetadata` / `writeStatus` / `writeSummary` / `appendEvent`
 * methods (below) are a parallel implementation of the same
 * `runs/<id>/` artifact contract that `RunStore` owns in
 * `src/modules/execution/run-store.service.ts`, operating on
 * `SubAgentRunRecord` instead of `ExecutionRunRecord`. We deliberately
 * did NOT extract a generic `RunArtifactStore<T>` base class in
 * Phase 9 — two consumers is not enough shape evidence. Revisit when a
 * third consumer shows up or when the two drift. Tracked in #264.
 */
@Injectable()
export class SubAgentService {
  private readonly logger = new Logger(SubAgentService.name);
  private readonly artifactRoot = resolve(getConfig().artifactRoot);
  private readonly recentRuns: SubAgentRunRecord[] = [];
  private readonly recentRunLimit = 12;

  constructor(
    @Inject(SettingsService) private readonly settingsService: SettingsService,
  ) {}

  listRecentRuns(): SubAgentRunRecord[] {
    return [...this.recentRuns].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async runDelegation(input: DelegateSubAgentToolInput, hooks: RunHooks = {}): Promise<SubAgentRunRecord> {
    const runId = `sub_${Date.now()}`;
    const createdAt = this.now();
    const artifactDir = runDir(this.artifactRoot, runId);
    mkdirSync(artifactDir, { recursive: true });

    let run: SubAgentRunRecord = {
      run_id: runId,
      agent_type: input.agent_type,
      task: input.task.trim(),
      status: "queued",
      created_at: createdAt,
      updated_at: createdAt,
      repo: input.repo?.trim() || undefined,
      focus_paths: input.focus_paths?.filter(Boolean),
      work_item_ids: input.work_item_ids?.filter(Boolean),
      notes: input.notes?.trim() || undefined,
      artifact_dir: artifactDir,
      progress_message: "Queued specialist run.",
    };

    this.upsertRecentRun(run);
    this.writeMetadata(run);
    this.writeStatus(run);
    this.appendEvent(run, { type: "run_created", task: run.task });
    hooks.onStatus?.(run);

    try {
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: process.cwd(),
        sessionManager: SessionManager.inMemory(process.cwd()),
        model: this.settingsService.getSelectedModel(),
        tools: ["read", "bash", "grep"],
      });

      if (modelFallbackMessage) {
        this.logger.warn(modelFallbackMessage);
      }

      run = this.updateRun(run, {
        status: "running",
        started_at: this.now(),
        session_id: session.sessionId,
        progress_message: "Sub-agent session started.",
      });
      hooks.onStatus?.(run);
      this.appendEvent(run, { type: "session_started", session_id: session.sessionId });

      const unsubscribe = session.subscribe((event) => {
        this.handleSessionEvent(run, event, hooks.onStatus);
      });

      try {
        await session.prompt(this.buildPrompt(run));
      } finally {
        unsubscribe();
        session.dispose();
      }

      const assistantText = session.getLastAssistantText()?.trim() ?? "";
      writeFileSync(join(artifactDir, "outputs", "response.json"), this.ensureJsonText(assistantText), "utf8");

      const result = this.parseResult(run, assistantText);
      run = this.updateRun(run, {
        status: result.status === "completed" ? "completed" : "error",
        completed_at: this.now(),
        progress_message: result.status === "completed" ? "Sub-agent completed." : "Sub-agent returned an error result.",
        result,
      });

      this.writeSummary(run);
      this.appendEvent(run, { type: "run_completed", result });
      hooks.onStatus?.(run);
      hooks.onResult?.(run);
      return run;
    } catch (error) {
      const result: SubAgentResultEnvelope = {
        run_id: run.run_id,
        agent_type: run.agent_type,
        status: "error",
        summary: `Sub-agent failed before producing a valid result: ${this.getErrorMessage(error)}`,
        confidence: "low",
        findings: [],
        errors: [{ code: "subagent_failed", message: this.getErrorMessage(error) }],
      };

      run = this.updateRun(run, {
        status: "error",
        completed_at: this.now(),
        progress_message: "Sub-agent failed.",
        result,
      });
      this.writeSummary(run);
      this.appendEvent(run, { type: "run_failed", error: this.getErrorMessage(error), result });
      hooks.onStatus?.(run);
      hooks.onResult?.(run);
      return run;
    }
  }

  private buildPrompt(run: SubAgentRunRecord): string {
    const role = this.getAgentRolePrompt(run.agent_type);
    const focusPaths = run.focus_paths?.length ? run.focus_paths.map((path) => `- ${path}`).join("\n") : "- (none provided)";
    const workItemIds = run.work_item_ids?.length ? run.work_item_ids.map((id) => `- ${id}`).join("\n") : "- (none provided)";

    return [
      `You are the ${run.agent_type} specialist for Escapement Studio.`,
      role,
      "",
      "Boundaries:",
      "- Stay focused on the requested task.",
      "- Use repository inspection tools as needed, but keep evidence concise and bounded.",
      "- Do not modify files.",
      "- Return JSON only. No markdown fences, no commentary before or after the JSON.",
      "",
      "Return exactly this JSON envelope shape:",
      JSON.stringify({
        run_id: run.run_id,
        agent_type: run.agent_type,
        status: "completed",
        summary: "Short result summary.",
        confidence: "medium",
        findings: [
          {
            kind: "file_impact",
            file: "path/to/file.ts",
            lines: "1-20",
            summary: "Why this file matters.",
            snippet: "short bounded snippet if useful",
          },
        ],
        open_questions: [],
        errors: [],
      }, null, 2),
      "",
      "Task:",
      run.task,
      "",
      `Repo: ${run.repo ?? "(not specified)"}`,
      "",
      "Focus paths:",
      focusPaths,
      "",
      "Related work item IDs:",
      workItemIds,
      "",
      `Additional notes: ${run.notes ?? "(none)"}`,
    ].join("\n");
  }

  private getAgentRolePrompt(agentType: SubAgentType): string {
    switch (agentType) {
      case "code-crawler":
        return [
          "Your job is to inspect the codebase and report concrete implementation evidence.",
          "Prioritize findings of kinds: file_impact, pattern_match, dependency, entrypoint, risk.",
          "Trace imports, entrypoints, and nearby modules when relevant.",
        ].join(" ");
      case "scope-predictor":
        return [
          "Your job is to predict likely file/module impact for the requested change.",
          "Prioritize findings of kinds: predicted_file, predicted_module, likely_dependency, uncertainty.",
          "Focus on bounded predicted impact, not exhaustive dumps.",
        ].join(" ");
      case "reconciliation-analyst":
        return [
          "Your job is to compare predicted scope to actual execution results and explain planning drift clearly.",
          "Prioritize findings of kinds: prediction_match, prediction_miss, overprediction, drift_pattern, recommendation.",
          "Focus on concise reconciliation learnings that can improve future planning and memory.",
        ].join(" ");
    }
  }

  private parseResult(run: SubAgentRunRecord, assistantText: string): SubAgentResultEnvelope {
    const jsonText = this.ensureJsonText(assistantText);

    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const status = parsed.status === "error" ? "error" : "completed";
      return {
        run_id: run.run_id,
        agent_type: run.agent_type,
        status,
        summary: typeof parsed.summary === "string" ? parsed.summary : "Sub-agent completed without a summary.",
        confidence: parsed.confidence === "low" || parsed.confidence === "high" ? parsed.confidence : "medium",
        findings: Array.isArray(parsed.findings)
          ? parsed.findings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => ({ ...item, kind: typeof item.kind === "string" ? item.kind : "finding" }))
          : [],
        open_questions: Array.isArray(parsed.open_questions)
          ? parsed.open_questions.filter((item): item is string => typeof item === "string")
          : [],
        errors: Array.isArray(parsed.errors)
          ? parsed.errors.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => ({
              code: typeof item.code === "string" ? item.code : "subagent_error",
              message: typeof item.message === "string" ? item.message : JSON.stringify(item),
            }))
          : [],
      };
    } catch (error) {
      return {
        run_id: run.run_id,
        agent_type: run.agent_type,
        status: "error",
        summary: "Sub-agent returned a non-JSON response.",
        confidence: "low",
        findings: [],
        errors: [{ code: "invalid_json", message: this.getErrorMessage(error) }],
      };
    }
  }

  private handleSessionEvent(run: SubAgentRunRecord, event: AgentSessionEvent, onStatus?: (run: SubAgentRunRecord) => void) {
    if (event.type === "tool_execution_start") {
      const nextRun = this.updateRun(run, {
        progress_message: `${event.toolName ?? "tool"} running…`,
      });
      this.appendEvent(nextRun, { type: event.type, tool_name: event.toolName ?? null });
      onStatus?.(nextRun);
      return;
    }

    if (event.type === "tool_execution_end") {
      const nextRun = this.updateRun(run, {
        progress_message: `${event.toolName ?? "tool"} finished.`,
      });
      this.appendEvent(nextRun, { type: event.type, tool_name: event.toolName ?? null });
      onStatus?.(nextRun);
      return;
    }

    if (event.type === "message_end") {
      this.appendEvent(run, { type: event.type });
    }
  }

  private updateRun(run: SubAgentRunRecord, patch: Partial<SubAgentRunRecord>): SubAgentRunRecord {
    const nextRun: SubAgentRunRecord = {
      ...run,
      ...patch,
      updated_at: this.now(),
    };
    this.upsertRecentRun(nextRun);
    this.writeStatus(nextRun);
    return nextRun;
  }

  private upsertRecentRun(run: SubAgentRunRecord) {
    const index = this.recentRuns.findIndex((candidate) => candidate.run_id === run.run_id);
    if (index >= 0) {
      this.recentRuns[index] = run;
    } else {
      this.recentRuns.unshift(run);
    }
    this.recentRuns.splice(this.recentRunLimit);
  }

  private writeMetadata(run: SubAgentRunRecord) {
    mkdirSync(join(run.artifact_dir, "outputs"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "metadata.json"), JSON.stringify({
      run_id: run.run_id,
      run_type: "subagent",
      created_at: run.created_at,
      agent_type: run.agent_type,
      repo: run.repo ?? null,
      work_item_ids: run.work_item_ids ?? [],
      focus_paths: run.focus_paths ?? [],
      task: run.task,
      cwd: process.cwd(),
    }, null, 2), "utf8");
  }

  private writeStatus(run: SubAgentRunRecord) {
    writeFileSync(join(run.artifact_dir, "status.json"), JSON.stringify({
      run_id: run.run_id,
      status: run.status,
      phase: this.getPhase(run.status),
      started_at: run.started_at ?? null,
      updated_at: run.updated_at,
      completed_at: run.completed_at ?? null,
      progress_message: run.progress_message ?? null,
      result: run.result ?? null,
    }, null, 2), "utf8");
  }

  private writeSummary(run: SubAgentRunRecord) {
    const result = run.result;
    if (!result) {
      return;
    }

    const findings = result.findings.length === 0
      ? "- None"
      : result.findings.map((finding) => {
          const location = typeof finding.file === "string" ? ` (${finding.file}${typeof finding.lines === "string" ? `:${finding.lines}` : ""})` : "";
          return `- ${finding.kind}${location}: ${typeof finding.summary === "string" ? finding.summary : "(no summary)"}`;
        }).join("\n");

    writeFileSync(join(run.artifact_dir, "summary.md"), [
      `# ${run.agent_type} run ${run.run_id}`,
      "",
      `- Status: ${run.status}`,
      `- Confidence: ${result.confidence}`,
      `- Task: ${run.task}`,
      "",
      "## Summary",
      result.summary,
      "",
      "## Findings",
      findings,
      "",
      "## Open Questions",
      result.open_questions?.length ? result.open_questions.map((question) => `- ${question}`).join("\n") : "- None",
      "",
      "## Errors",
      result.errors?.length ? result.errors.map((error) => `- ${error.code}: ${error.message}`).join("\n") : "- None",
      "",
    ].join("\n"), "utf8");
  }

  private appendEvent(run: SubAgentRunRecord, event: Record<string, unknown>) {
    appendFileSync(join(run.artifact_dir, "events.jsonl"), `${JSON.stringify({ timestamp: this.now(), ...event })}\n`, "utf8");
  }

  private getPhase(status: SubAgentRunStatus): string {
    switch (status) {
      case "queued":
        return "queued";
      case "running":
        return "analysis";
      case "completed":
        return "completed";
      case "error":
        return "failed";
    }
  }

  private ensureJsonText(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      return trimmed.replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
    }
    return trimmed;
  }

  private now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
