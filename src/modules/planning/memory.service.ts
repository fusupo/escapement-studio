import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  PlanningMemoryApplyResult,
  PlanningMemoryChange,
  PlanningMemoryDocument,
  PlanningMemoryEdit,
} from "./types.js";

@Injectable()
export class MemoryService {
  private readonly memoryPath = resolve(process.cwd(), "PLANNING_MEMORY.md");

  read(): PlanningMemoryDocument {
    const content = readFileSync(this.memoryPath, "utf8").replace(/\r/g, "");
    return {
      path: this.memoryPath,
      content,
      content_hash: this.hash(content),
    };
  }

  applyChange(change: PlanningMemoryChange, approvedEditIds: string[]): { result: PlanningMemoryApplyResult; memory: PlanningMemoryDocument } {
    const memory = this.read();

    if (memory.content_hash !== change.based_on_content_hash) {
      return {
        result: {
          status: "stale",
          previous_content_hash: change.based_on_content_hash,
          current_content_hash: memory.content_hash,
          message: "Planning memory changed since this edit set was staged and must be regenerated.",
        },
        memory,
      };
    }

    const selectedEdits = approvedEditIds.map((id) => {
      const edit = change.edits.find((candidate) => candidate.id === id);
      if (!edit) {
        return null;
      }
      return edit;
    });

    const missingEditIds = approvedEditIds.filter((id, index) => !selectedEdits[index]);
    if (missingEditIds.length > 0) {
      return {
        result: {
          status: "validation_failed",
          errors: missingEditIds.map((editId) => ({ edit_id: editId, message: "Unknown memory edit id" })),
        },
        memory,
      };
    }

    const validationErrors = this.validateEdits(memory.content, selectedEdits as PlanningMemoryEdit[]);
    if (validationErrors.length > 0) {
      return {
        result: {
          status: "validation_failed",
          errors: validationErrors,
        },
        memory,
      };
    }

    const nextContent = this.applyEdits(memory.content, selectedEdits as PlanningMemoryEdit[]);
    writeFileSync(this.memoryPath, nextContent, "utf8");

    const nextMemory = this.read();
    return {
      result: {
        status: "applied",
        applied_edit_ids: approvedEditIds,
        previous_content_hash: memory.content_hash,
        new_content_hash: nextMemory.content_hash,
      },
      memory: nextMemory,
    };
  }

  private validateEdits(content: string, edits: PlanningMemoryEdit[]): Array<{ edit_id: string; message: string }> {
    const errors: Array<{ edit_id: string; message: string }> = [];

    for (const edit of edits) {
      switch (edit.kind) {
        case "replace_text": {
          if (!edit.old_text) {
            errors.push({ edit_id: edit.id, message: "replace_text edit requires old_text" });
            break;
          }

          if (typeof edit.new_text !== "string") {
            errors.push({ edit_id: edit.id, message: "replace_text edit requires new_text" });
            break;
          }

          const count = this.countOccurrences(content, edit.old_text);
          if (count === 0) {
            errors.push({ edit_id: edit.id, message: "replace_text old_text was not found" });
          } else if (count > 1) {
            errors.push({ edit_id: edit.id, message: "replace_text old_text matched multiple locations" });
          }
          break;
        }

        case "delete_text": {
          if (!edit.old_text) {
            errors.push({ edit_id: edit.id, message: "delete_text edit requires old_text" });
            break;
          }

          const count = this.countOccurrences(content, edit.old_text);
          if (count === 0) {
            errors.push({ edit_id: edit.id, message: "delete_text old_text was not found" });
          } else if (count > 1) {
            errors.push({ edit_id: edit.id, message: "delete_text old_text matched multiple locations" });
          }
          break;
        }

        case "insert_after_heading": {
          if (!edit.target_heading?.trim()) {
            errors.push({ edit_id: edit.id, message: "insert_after_heading edit requires target_heading" });
            break;
          }

          if (!edit.new_text?.trim()) {
            errors.push({ edit_id: edit.id, message: "insert_after_heading edit requires new_text" });
            break;
          }

          const heading = this.normalizeHeading(edit.target_heading);
          if (!content.includes(`\n${heading}\n`) && !content.startsWith(`${heading}\n`)) {
            errors.push({ edit_id: edit.id, message: `Heading not found: ${heading}` });
          }
          break;
        }
      }
    }

    return errors;
  }

  private applyEdits(content: string, edits: PlanningMemoryEdit[]): string {
    let next = content;

    for (const edit of edits) {
      switch (edit.kind) {
        case "replace_text":
          next = next.replace(edit.old_text ?? "", edit.new_text ?? "");
          break;
        case "delete_text":
          next = next.replace(edit.old_text ?? "", "");
          break;
        case "insert_after_heading":
          next = this.insertAfterHeading(next, this.normalizeHeading(edit.target_heading ?? ""), edit.new_text ?? "");
          break;
      }
    }

    return this.normalizeSpacing(next);
  }

  private insertAfterHeading(content: string, heading: string, insertion: string): string {
    const normalizedInsertion = insertion.replace(/\r/g, "").trimEnd();
    const headingIndex = content.indexOf(heading);
    if (headingIndex < 0) {
      return content;
    }

    const lineEndIndex = content.indexOf("\n", headingIndex);
    const insertAt = lineEndIndex >= 0 ? lineEndIndex + 1 : content.length;
    return `${content.slice(0, insertAt)}${normalizedInsertion}\n${content.slice(insertAt)}`;
  }

  private normalizeHeading(value: string): string {
    const trimmed = value.trim();
    return trimmed.startsWith("## ") ? trimmed : `## ${trimmed.replace(/^#+\s*/, "")}`;
  }

  private normalizeSpacing(value: string): string {
    return `${value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  }

  private countOccurrences(content: string, target: string): number {
    if (!target) {
      return 0;
    }

    let count = 0;
    let fromIndex = 0;

    while (true) {
      const index = content.indexOf(target, fromIndex);
      if (index === -1) {
        return count;
      }
      count += 1;
      fromIndex = index + target.length;
    }
  }

  private hash(content: string): string {
    return createHash("sha1").update(content).digest("hex");
  }
}
