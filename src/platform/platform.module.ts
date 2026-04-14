import { Global, Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { SQLiteService } from "./sqlite.service.js";

/**
 * Global platform infrastructure. Every feature module gets access to
 * CommandBus, EventBus, QueryBus (from @nestjs/cqrs) and SQLiteService
 * without having to import PlatformModule explicitly — the @Global()
 * decorator makes its exports available to every module.
 *
 * Feature modules MUST NOT import other feature modules directly.
 * Cross-context communication routes through:
 *
 *   - CommandBus.execute(new OtherContextCommand(...))  — when one caller
 *     expects one handler to run and return a result
 *   - EventBus.publish(new SomethingHappenedEvent(...))  — when N
 *     subscribers react to a domain fact, fire-and-forget
 *
 * Phase 6a (#235) adds `SQLiteService` here. It used to live in
 * `GraphModule` but `SQLiteService` is infrastructure, not domain —
 * placing it in the global platform removes the transitive
 * `Settings → Graph`, `Execution → Settings`, `Plans → Settings`
 * forwardRef cycles that depended on Graph being the DB host.
 *
 * See docs/proposals/phase-0-platform-bus.md for the CQRS bus
 * conventions and docs/proposals/phase-6-platform-module.md for
 * the SQLite relocation rationale.
 */
@Global()
@Module({
  imports: [CqrsModule],
  providers: [SQLiteService],
  exports: [CqrsModule, SQLiteService],
})
export class PlatformModule {}
