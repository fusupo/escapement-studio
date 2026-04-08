import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { SettingsService, type SettingsUpdate } from "./settings.service.js";

@Controller("api/settings")
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  getSettings() {
    return this.settings.getSettings();
  }

  @Put()
  updateSettings(@Body() body: SettingsUpdate) {
    return this.settings.updateSettings(body);
  }
}
