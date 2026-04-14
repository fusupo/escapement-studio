import { Module } from "@nestjs/common";
import { ModelRegistryService } from "./model-registry.service.js";
import { SettingsController } from "./settings.controller.js";
import { SettingsService } from "./settings.service.js";

/**
 * Phase 6a (#235): `SettingsModule` no longer imports `GraphModule`.
 * `SettingsService` only injected `SQLiteService` from the graph side,
 * and after Phase 6a that comes from the @Global PlatformModule
 * (src/platform/) so Settings has zero domain-module dependencies.
 * Dropping the forward-referenced Graph import here is the first leg
 * of the −3 forwardRef cleanup — it unblocks the follow-up unwraps
 * on ExecutionModule and PlansModule where the forward-referenced
 * Settings import defended cycles that went through Settings → Graph.
 */
@Module({
  imports: [],
  controllers: [SettingsController],
  providers: [SettingsService, ModelRegistryService],
  exports: [SettingsService, ModelRegistryService],
})
export class SettingsModule {}
