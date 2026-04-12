import { Injectable } from "@nestjs/common";
import type { HsmActionContext } from "./hsm-action-handlers.js";

@Injectable()
export class HsmGuardHandlers {
  async prExistsForBranch(_ctx: HsmActionContext): Promise<boolean> {
    return false;
  }
}
