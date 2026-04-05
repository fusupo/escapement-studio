import { BadRequestException, Inject, Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Observable, Subject } from "rxjs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { getConfig } from "../../config.js";
import { ContextService } from "./context.service.js";
import type { SendAgentMessageDto, SendAgentMessageResult, StudioSseEnvelope } from "./types.js";

@Injectable()
export class PlanningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlanningService.name);
  private readonly streamId = "planning-root";
  private readonly eventSubject = new Subject<MessageEvent>();
  private readonly sessionDir = resolve(process.cwd(), getConfig().planningSessionDir);

  private session?: AgentSession;
  private sessionPromise?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private eventCounter = 0;
  private turnCounter = 0;
  private currentTurnId: string | null = null;

  constructor(@Inject(ContextService) private readonly contextService: ContextService) {}

  async onModuleInit() {
    await this.ensureSession();
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    this.session?.dispose();
    this.eventSubject.complete();
  }

  stream(): Observable<MessageEvent> {
    void this.ensureSession();

    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.eventSubject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  async sendMessage(input: SendAgentMessageDto): Promise<SendAgentMessageResult> {
    if (!input.message?.trim()) {
      throw new BadRequestException("message is required");
    }

    const session = await this.ensureSession();
    const prompt = this.contextService.formatForPrompt(
      this.contextService.assemble({
        graph_mode: input.context?.graph_mode,
        repo: input.context?.repo,
        track: input.context?.track,
        session,
      }),
      input.message,
    );

    const queued = session.isStreaming;
    const promptPromise = queued
      ? session.prompt(prompt, { streamingBehavior: "followUp" })
      : session.prompt(prompt);

    void promptPromise.catch((error) => {
      this.logger.error(`Planner prompt failed: ${this.getErrorMessage(error)}`);
    });

    return {
      accepted: true,
      queued,
      session_id: session.sessionId,
      session_file: session.sessionFile,
    };
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) {
      return this.session;
    }

    if (!this.sessionPromise) {
      this.sessionPromise = this.createOrResumeSession().catch((error) => {
        this.sessionPromise = undefined;
        throw error;
      });
    }

    this.session = await this.sessionPromise;
    return this.session;
  }

  private async createOrResumeSession(): Promise<AgentSession> {
    mkdirSync(this.sessionDir, { recursive: true });

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: SessionManager.continueRecent(process.cwd(), this.sessionDir),
    });

    if (modelFallbackMessage) {
      this.logger.warn(modelFallbackMessage);
    }

    this.unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(event);
    });

    this.logger.log(`Root planner ready: ${session.sessionId} (${session.sessionFile ?? "in-memory"})`);
    return session;
  }

  private handleSessionEvent(event: AgentSessionEvent) {
    if (event.type === "turn_start") {
      this.currentTurnId = `turn_${String(++this.turnCounter).padStart(4, "0")}`;
    }

    if (!this.isStreamableEvent(event.type)) {
      return;
    }

    const envelope: StudioSseEnvelope = {
      event_id: `evt_${String(++this.eventCounter).padStart(6, "0")}`,
      stream_id: this.streamId,
      timestamp: this.now(),
      event_type: event.type,
      session_id: this.session?.sessionId ?? "planning-root",
      turn_id: this.currentTurnId,
      payload: event,
    };

    this.eventSubject.next({
      id: envelope.event_id,
      type: envelope.event_type,
      data: envelope,
    });

    if (event.type === "turn_end") {
      this.currentTurnId = null;
    }
  }

  private isStreamableEvent(type: AgentSessionEvent["type"]): boolean {
    return [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ].includes(type);
  }

  private now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
