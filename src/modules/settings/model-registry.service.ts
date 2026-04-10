import { Injectable, Logger } from "@nestjs/common";
import { ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  available: boolean;
}

/**
 * Wraps pi-coding-agent's ModelRegistry as a NestJS singleton.
 * Exposes available models for the settings UI and resolves
 * persisted model selections to Model instances.
 */
@Injectable()
export class ModelRegistryService {
  private readonly logger = new Logger(ModelRegistryService.name);
  private registry: ModelRegistry;

  constructor() {
    try {
      const authStorage = AuthStorage.create();
      this.registry = ModelRegistry.create(authStorage);
      const error = this.registry.getError();
      if (error) {
        this.logger.warn(`ModelRegistry loaded with warnings: ${error}`);
      }
    } catch (err) {
      this.logger.error(`Failed to create ModelRegistry: ${err}`);
      // Create an in-memory fallback so the service doesn't crash
      const authStorage = AuthStorage.inMemory();
      this.registry = ModelRegistry.inMemory(authStorage);
    }
  }

  /**
   * List all models with availability info for the frontend.
   */
  listModels(): ModelInfo[] {
    const all = this.registry.getAll();
    return all.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      available: this.registry.hasConfiguredAuth(m),
    }));
  }

  /**
   * Find and return a Model instance by provider + modelId.
   * Returns undefined if the model is not in the registry.
   */
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.registry.find(provider, modelId);
  }
}
