import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

/**
 * Phase 6a (#235): dropped the `GraphModule` import. `HealthService`
 * only injected `SQLiteService` from the graph side, and SQLite
 * now lives in the @Global PlatformModule. Health has no domain
 * dependencies — it just hosts the `/health` endpoint that probes
 * the DB.
 */
@Module({
  imports: [],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
