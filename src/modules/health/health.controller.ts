import { Controller, Get, Inject } from "@nestjs/common";
import { HealthService } from "./health.service.js";

@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get("health")
  getHealth() {
    return this.healthService.getStatus();
  }
}
