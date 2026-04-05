import { Inject, Injectable } from "@nestjs/common";
import { SQLiteService } from "../graph/sqlite.service.js";

@Injectable()
export class HealthService {
  constructor(@Inject(SQLiteService) private readonly sqlite: SQLiteService) {}

  getStatus() {
    return {
      ok: true,
      db: {
        path: this.sqlite.getPath(),
        healthy: this.sqlite.isHealthy(),
        hasSchema: this.sqlite.hasSchema(),
      },
    };
  }
}
