import { Inject, Injectable } from "@nestjs/common";
import {
  CommandBus,
  CommandHandler,
  EventBus,
  EventsHandler,
  ICommand,
  ICommandHandler,
  IEvent,
  IEventHandler,
} from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { PlatformModule } from "../platform.module.js";

class PingCommand implements ICommand {
  constructor(public readonly message: string) {}
}

class PongEvent implements IEvent {
  constructor(public readonly echo: string) {}
}

// Explicit @Inject(EventBus) is required: this repo runs vitest with the
// default esbuild transformer, which does not emit `design:paramtypes`
// decorator metadata, so Nest cannot infer the constructor dependency
// from the TypeScript type. Real production handlers compiled by `tsc`
// will have metadata and can use the implicit form.
@CommandHandler(PingCommand)
@Injectable()
class PingHandler implements ICommandHandler<PingCommand, string> {
  constructor(@Inject(EventBus) private readonly eventBus: EventBus) {}

  async execute(command: PingCommand): Promise<string> {
    const response = `pong:${command.message}`;
    this.eventBus.publish(new PongEvent(response));
    return response;
  }
}

@EventsHandler(PongEvent)
@Injectable()
class PongRecorder implements IEventHandler<PongEvent> {
  readonly received: string[] = [];

  handle(event: PongEvent): void {
    this.received.push(event.echo);
  }
}

describe("platform bus smoke test", () => {
  let commandBus: CommandBus;
  let recorder: PongRecorder;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PlatformModule],
      providers: [PingHandler, PongRecorder],
    }).compile();

    // CqrsModule registers decorated handlers during app bootstrap.
    // Test.createTestingModule does not call onApplicationBootstrap
    // automatically — init() triggers it.
    await moduleRef.init();

    commandBus = moduleRef.get(CommandBus);
    recorder = moduleRef.get(PongRecorder);
  });

  it("routes a command through its handler and returns the result", async () => {
    const result = await commandBus.execute<PingCommand, string>(
      new PingCommand("hello"),
    );
    expect(result).toBe("pong:hello");
  });

  it("publishes an event from inside a handler and routes it to subscribers", async () => {
    await commandBus.execute<PingCommand, string>(new PingCommand("world"));
    expect(recorder.received).toEqual(["pong:world"]);
  });

  it("throws when a command has no registered handler", () => {
    class UnregisteredCommand implements ICommand {}
    // @nestjs/cqrs v11 throws synchronously from execute() when the
    // command id lookup fails, before constructing a returnable promise,
    // so the assertion uses a thunk rather than .rejects.
    expect(() => commandBus.execute(new UnregisteredCommand())).toThrow(
      /No handler found/,
    );
  });
});
