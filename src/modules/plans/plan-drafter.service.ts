import { Injectable, Inject, Logger } from "@nestjs/common";
import {
  createAgentSession,
  createBashTool,
  createGrepTool,
  createReadTool,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { WorkItemRecord } from "../graph/types.js";
import type { PlanDraftEnvelope, PlanDraftTask, PlanDraftTechnicalNotes } from "./types.js";
import { SettingsService } from "../settings/settings.service.js";

/**
 * ADR 014 step 8 follow-up (#167) — auto-draft the plan scratchpad via a
 * one-shot pi-coding-agent session driven by the canonical setup-work skill
 * shipped in the `escapement` npm dep at
 * `node_modules/escapement/skills/setup-work/SKILL.md`.
 *
 * The drafter is stateless: each `draft()` call resolves the skill file
 * fresh, builds a programmatic-mode prompt, runs `createAgentSession` with
 * read-only tools (Read, Grep, Bash) scoped to `process.cwd()`, parses the
 * agent's final assistant message as a `PlanDraftEnvelope`, and returns it.
 *
 * Failures throw — `PlansService.prepare` is responsible for surfacing them
 * to the HTTP client without transitioning work item state.
 */
@Injectable()
export class PlanDrafterService {
  private readonly logger = new Logger(PlanDrafterService.name);

  constructor(
    @Inject(SettingsService) private readonly settingsService: SettingsService,
  ) {}

  /**
   * Run a one-shot drafting session for a work item. Returns the parsed
   * envelope on success; throws on any failure (skill load, agent error,
   * malformed JSON, missing required fields).
   */
  async draft(
    workItem: WorkItemRecord,
    issueBody: string | null,
  ): Promise<PlanDraftEnvelope> {
    const skillBody = this.loadSkillBody();
    const prompt = this.buildDraftPrompt({ skillBody, workItem, issueBody });

    this.logger.log(
      `Drafting plan for ${workItem.id} (prompt size: ${prompt.length} chars)`,
    );

    const cwd = process.cwd();
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      model: this.settingsService.getSelectedModel(),
      tools: [
        createReadTool(cwd),
        createGrepTool(cwd),
        createBashTool(cwd),
      ],
    });

    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    let assistantText: string;
    try {
      await session.prompt(prompt);
      assistantText = session.getLastAssistantText()?.trim() ?? "";
    } finally {
      session.dispose();
    }

    if (!assistantText) {
      throw new Error(
        `PlanDrafterService.draft: agent session for ${workItem.id} returned an empty assistant message`,
      );
    }

    const envelope = this.parseEnvelope(assistantText);
    this.logger.log(
      `Drafted plan for ${workItem.id}: ${envelope.implementation_tasks.length} tasks, ` +
        `${envelope.affected_files.length} files, ${envelope.questions.length} open questions`,
    );
    return envelope;
  }

  /**
   * Parse the agent's final assistant message as a `PlanDraftEnvelope`.
   *
   * Strips optional markdown code fences (```json ... ```), trims whitespace,
   * `JSON.parse`s the result, and validates the required fields. Throws
   * with a clear message on any failure so `PlansService.prepare` can surface
   * the error verbatim to the HTTP client.
   */
  parseEnvelope(text: string): PlanDraftEnvelope {
    let cleaned = text.trim();
    // Strip ```json ... ``` or ``` ... ``` code fences if the agent ignored
    // the no-fences instruction.
    const fenceMatch = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n```\s*$/.exec(cleaned);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    // Models occasionally add preamble or postamble around the JSON envelope
    // even when explicitly told not to (e.g. "Now I have enough to draft the
    // plan. Producing the JSON envelope.\n\n{ ... }\n\nThat's the plan!").
    // Always try to extract the first balanced JSON object and use that as
    // the parse target — falls back to the cleaned text if no balanced object
    // is found.
    const extracted = this.extractFirstJsonObject(cleaned);
    if (extracted) {
      cleaned = extracted;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `PlanDrafterService.parseEnvelope: agent response is not valid JSON: ${message}. ` +
          `First 200 chars: ${cleaned.slice(0, 200)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `PlanDrafterService.parseEnvelope: agent response parsed but is not a JSON object`,
      );
    }

    const obj = parsed as Record<string, unknown>;

    const requireString = (field: string): string => {
      const value = obj[field];
      if (typeof value !== "string") {
        throw new Error(
          `PlanDrafterService.parseEnvelope: missing or non-string field '${field}'`,
        );
      }
      return value;
    };

    const requireStringArray = (field: string): string[] => {
      const value = obj[field];
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(
          `PlanDrafterService.parseEnvelope: field '${field}' must be an array of strings`,
        );
      }
      return value as string[];
    };

    const requireTaskArray = (field: string): PlanDraftTask[] => {
      const value = obj[field];
      if (!Array.isArray(value)) {
        throw new Error(
          `PlanDrafterService.parseEnvelope: field '${field}' must be an array`,
        );
      }
      return value.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error(
            `PlanDrafterService.parseEnvelope: ${field}[${index}] is not an object`,
          );
        }
        const task = raw as Record<string, unknown>;
        const stringField = (key: string): string => {
          const v = task[key];
          if (typeof v !== "string") {
            throw new Error(
              `PlanDrafterService.parseEnvelope: ${field}[${index}].${key} must be a string`,
            );
          }
          return v;
        };
        const stringArrayField = (key: string): string[] => {
          const v = task[key];
          if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
            throw new Error(
              `PlanDrafterService.parseEnvelope: ${field}[${index}].${key} must be an array of strings`,
            );
          }
          return v as string[];
        };
        return {
          description: stringField("description"),
          files: stringArrayField("files"),
          rationale: stringField("rationale"),
          testing: stringField("testing"),
        };
      });
    };

    const requireTechnicalNotes = (): PlanDraftTechnicalNotes => {
      const value = obj["technical_notes"];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
          `PlanDrafterService.parseEnvelope: field 'technical_notes' must be an object`,
        );
      }
      const notes = value as Record<string, unknown>;
      const stringField = (key: string): string => {
        const v = notes[key];
        if (typeof v !== "string") {
          throw new Error(
            `PlanDrafterService.parseEnvelope: technical_notes.${key} must be a string`,
          );
        }
        return v;
      };
      return {
        architecture: stringField("architecture"),
        approach: stringField("approach"),
        challenges: stringField("challenges"),
      };
    };

    return {
      summary: requireString("summary"),
      acceptance_criteria: requireStringArray("acceptance_criteria"),
      implementation_tasks: requireTaskArray("implementation_tasks"),
      affected_files: requireStringArray("affected_files"),
      questions: requireStringArray("questions"),
      assumptions: requireStringArray("assumptions"),
      blockers: requireStringArray("blockers"),
      technical_notes: requireTechnicalNotes(),
    };
  }

  /**
   * Resolve and read the canonical setup-work skill file from the
   * `escapement` npm dep. Re-read on every call so a fresh `npm install`
   * picks up new skill content without restarting the server.
   *
   * Throws if the file is missing — that indicates the dep is corrupt
   * or out of sync, and the drafter cannot operate.
   */
  loadSkillBody(): string {
    try {
      // createRequire(import.meta.url) gives us a CommonJS-style resolver
      // that can locate non-JS assets inside node_modules.
      const require = createRequire(import.meta.url);
      const skillPath = require.resolve("escapement/skills/setup-work/SKILL.md");
      return readFileSync(skillPath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `PlanDrafterService.loadSkillBody: failed to resolve or read ` +
          `escapement/skills/setup-work/SKILL.md from node_modules. ` +
          `Reinstall the escapement dep. Underlying error: ${message}`,
      );
    }
  }

  /**
   * Build the prompt that drives the one-shot drafting session. The prompt
   * tells the agent it is in PROGRAMMATIC MODE (no human user), embeds the
   * full skill spec verbatim, supplies the work item context + issue body,
   * and demands a JSON envelope as the final assistant message.
   */
  buildDraftPrompt(args: {
    skillBody: string;
    workItem: WorkItemRecord;
    issueBody: string | null;
  }): string {
    const { skillBody, workItem, issueBody } = args;

    const exampleEnvelope: PlanDraftEnvelope = {
      summary: "One-paragraph statement of what this plan proposes.",
      acceptance_criteria: ["Criterion 1", "Criterion 2"],
      implementation_tasks: [
        {
          description: "Atomic task title",
          files: ["src/path/to/file.ts"],
          rationale: "Why this task and what it depends on.",
          testing: "What to test.",
        } satisfies PlanDraftTask,
      ],
      affected_files: ["src/path/to/file.ts"],
      questions: ["Unresolved question with options/trade-offs"],
      assumptions: ["Assumption made in absence of clarification"],
      blockers: ["Blocking dependency on #N"],
      technical_notes: {
        architecture: "Architecture considerations",
        approach: "Implementation approach + why",
        challenges: "Potential complexity, edge cases",
      } satisfies PlanDraftTechnicalNotes,
    };

    const workItemContext = [
      `- id: ${workItem.id}`,
      `- name: ${workItem.name}`,
      `- repo: ${workItem.repo ?? "(not set)"}`,
      `- issue_url: ${workItem.issue_url ?? "(not linked)"}`,
      `- scope_hint: ${workItem.scope_hint ?? "(not set)"}`,
      `- branch: ${workItem.branch ?? "(not set)"}`,
      `- predicted_files (current, may be refined): ${
        workItem.predicted_files.length
          ? workItem.predicted_files.join(", ")
          : "(none)"
      }`,
    ].join("\n");

    return [
      "# PROGRAMMATIC MODE",
      "",
      "You are operating in PROGRAMMATIC MODE on behalf of Escapement Studio's PlansService.",
      "There is NO human user in the loop. You cannot ask questions interactively.",
      "Surface unresolved questions in the JSON envelope's `questions` field.",
      "Do not write any files yourself — your caller writes the canonical scratchpad",
      "after parsing your final assistant message.",
      "Skip Phase 6 (workspace/branch creation) entirely — your caller manages branches.",
      "",
      "Your task: produce a JSON envelope (shape defined below) describing the drafted",
      "plan for the work item below, following the setup-work skill spec.",
      "",
      "## Setup-work skill spec (follow this verbatim)",
      "",
      skillBody,
      "",
      "## Work item context",
      "",
      workItemContext,
      "",
      "## Issue body",
      "",
      issueBody?.trim() ? issueBody.trim() : "_(issue body unavailable)_",
      "",
      "## JSON envelope schema",
      "",
      "Return EXACTLY this shape (use realistic content, not the placeholders):",
      "",
      JSON.stringify(exampleEnvelope, null, 2),
      "",
      "## Final instruction",
      "",
      "Your final assistant message MUST be ONLY the JSON envelope.",
      "No markdown code fences. No commentary before or after the JSON.",
      "No prose wrapper. The literal first character of your final message is `{`",
      "and the literal last character is `}`. The text between MUST parse as JSON",
      "matching the schema above.",
    ].join("\n");
  }

  /**
   * Extract the first balanced JSON object substring from `text`. Walks the
   * string from the first `{` and tracks brace depth (with proper handling
   * of string literals and escaped characters) until the matching closing
   * `}`. Returns the substring, or null if no balanced object is found.
   *
   * Used by `parseEnvelope` to recover from agent responses that include
   * preamble or postamble text around the JSON envelope.
   */
  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }
}
