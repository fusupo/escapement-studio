import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { ModelRegistryService } from "./model-registry.service.js";
import { SettingsController } from "./settings.controller.js";
import { SettingsService } from "./settings.service.js";

@Module({
  imports: [GraphModule],
  controllers: [SettingsController],
  providers: [SettingsService, ModelRegistryService],
  exports: [SettingsService, ModelRegistryService],
})
export class SettingsModule {}
