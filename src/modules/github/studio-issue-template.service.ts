import { Injectable } from "@nestjs/common";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export type StudioIssueTemplateKind = "bug" | "feature" | "task";

interface StudioIssueTemplateFrontmatter {
  name?: string;
  about?: string;
  title?: string;
  labels?: string[];
}

export interface StudioIssueTemplate {
  kind: StudioIssueTemplateKind;
  path: string;
  name: string;
  about?: string;
  defaultTitle?: string;
  labels: string[];
  body: string;
}

export interface StudioIssueTemplatePlanningDocument {
  path: string;
  content: string;
}

@Injectable()
export class StudioIssueTemplateService {
  private readonly templateDir = resolve(process.cwd(), ".github/ISSUE_TEMPLATE");

  listTemplates(): StudioIssueTemplate[] {
    if (!existsSync(this.templateDir)) {
      return [];
    }

    const entries = readdirSync(this.templateDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();

    return entries.map((entry) => this.readTemplate(resolve(this.templateDir, entry)));
  }

  getPlanningDocument(userMessage?: string): StudioIssueTemplatePlanningDocument | null {
    if (!this.looksLikeIssueCreationRequest(userMessage)) {
      return null;
    }

    const templates = this.listTemplates();
    if (templates.length === 0) {
      return null;
    }

    const inferredKind = this.inferKind(userMessage ?? "");
    const selectedTemplate = inferredKind
      ? templates.find((template) => template.kind === inferredKind) ?? this.defaultTemplate(templates)
      : this.defaultTemplate(templates);

    const availableTemplates = templates
      .map((template) => {
        const labels = template.labels.length > 0 ? template.labels.join(", ") : "(none)";
        const about = template.about ? ` — ${template.about}` : "";
        return `- ${template.kind}: ${template.name}${about} [labels: ${labels}]`;
      })
      .join("\n");

    const selectedTitlePrefix = selectedTemplate.defaultTitle ? `\n- Default title prefix: ${selectedTemplate.defaultTitle}` : "";
    const selectedLabels = selectedTemplate.labels.length > 0 ? selectedTemplate.labels.join(", ") : "(none)";

    const content = [
      "Escapement Studio canonical issue drafting templates",
      "Use these templates as internal drafting guidance when creating GitHub issues. Fill sections with grounded content from the user request and lightweight repo context. Omit or collapse sections only when the information is genuinely unavailable or the user explicitly wants a quick capture.",
      "",
      `Inferred issue kind: ${inferredKind ?? "unspecified"}`,
      `Selected template: ${selectedTemplate.kind} (${basename(selectedTemplate.path)})`,
      "",
      "Available templates:",
      availableTemplates,
      "",
      "Selected template metadata:",
      `- Name: ${selectedTemplate.name}`,
      `- Suggested labels: ${selectedLabels}`,
      `${selectedTitlePrefix}`.trimEnd(),
      "",
      "Selected template body:",
      selectedTemplate.body,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      path: selectedTemplate.path,
      content,
    };
  }

  private readTemplate(path: string): StudioIssueTemplate {
    const raw = readFileSync(path, "utf8");
    const { frontmatter, body } = this.parseFrontmatter(raw);
    const kind = this.inferKindFromPath(path);

    return {
      kind,
      path,
      name: frontmatter.name?.trim() || this.defaultTemplateName(kind),
      about: frontmatter.about?.trim() || undefined,
      defaultTitle: frontmatter.title?.trim() || undefined,
      labels: frontmatter.labels ?? [],
      body: body.trim(),
    };
  }

  private parseFrontmatter(raw: string): { frontmatter: StudioIssueTemplateFrontmatter; body: string } {
    const normalized = raw.replace(/\r/g, "");
    const lines = normalized.split("\n");

    if (lines[0]?.trim() !== "---") {
      return { frontmatter: {}, body: normalized };
    }

    const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (endIndex === -1) {
      return { frontmatter: {}, body: normalized };
    }

    const frontmatterLines = lines.slice(1, endIndex);
    const body = lines.slice(endIndex + 1).join("\n");
    const frontmatter: StudioIssueTemplateFrontmatter = {};

    for (const line of frontmatterLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = this.stripQuotes(trimmed.slice(separatorIndex + 1).trim());

      switch (key) {
        case "name":
          frontmatter.name = value;
          break;
        case "about":
          frontmatter.about = value;
          break;
        case "title":
          frontmatter.title = value;
          break;
        case "labels":
          frontmatter.labels = value
            .split(",")
            .map((label) => this.stripQuotes(label.trim()))
            .filter(Boolean);
          break;
      }
    }

    return { frontmatter, body };
  }

  private stripQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  private looksLikeIssueCreationRequest(userMessage?: string): boolean {
    if (!userMessage?.trim()) {
      return false;
    }

    return /\b(create|file|open|draft|write)\b.*\b(issue|bug|ticket|feature request)\b|\bissue\b.*\b(create|draft|write)\b/i.test(userMessage);
  }

  private inferKind(message: string): StudioIssueTemplateKind | null {
    if (/\b(bug|regression|broken|error|failure|failing|incorrect|unexpected)\b/i.test(message)) {
      return "bug";
    }

    if (/\b(task|chore|cleanup|clean up|refactor|maintenance|follow-?up)\b/i.test(message)) {
      return "task";
    }

    if (/\b(feature|enhancement|support|add|implement|allow|enable)\b/i.test(message)) {
      return "feature";
    }

    return null;
  }

  private inferKindFromPath(path: string): StudioIssueTemplateKind {
    const fileName = basename(path).toLowerCase();
    if (fileName.includes("bug")) {
      return "bug";
    }
    if (fileName.includes("task") || fileName.includes("chore")) {
      return "task";
    }
    return "feature";
  }

  private defaultTemplate(templates: StudioIssueTemplate[]): StudioIssueTemplate {
    return templates.find((template) => template.kind === "feature") ?? templates[0];
  }

  private defaultTemplateName(kind: StudioIssueTemplateKind): string {
    switch (kind) {
      case "bug":
        return "Bug report";
      case "feature":
        return "Feature request";
      case "task":
        return "Task";
    }
  }
}
