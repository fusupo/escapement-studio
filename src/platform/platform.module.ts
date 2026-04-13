import { Global, Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

/**
 * Global platform infrastructure. Every feature module gets access to
 * CommandBus, EventBus, and QueryBus (from @nestjs/cqrs) without having
 * to import PlatformModule explicitly — the @Global() decorator makes
 * its exports available to every module.
 *
 * Feature modules MUST NOT import other feature modules directly.
 * Cross-context communication routes through:
 *
 *   - CommandBus.execute(new OtherContextCommand(...))  — when one caller
 *     expects one handler to run and return a result
 *   - EventBus.publish(new SomethingHappenedEvent(...))  — when N
 *     subscribers react to a domain fact, fire-and-forget
 *
 * See docs/proposals/phase-0-platform-bus.md for the conventions the bus
 * imposes and the rationale for the module star-shape.
 */
@Global()
@Module({
  imports: [CqrsModule],
  exports: [CqrsModule],
})
export class PlatformModule {}
