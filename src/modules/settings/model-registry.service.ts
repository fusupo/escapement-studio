import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  available: boolean;
}

/**
 * Wraps pi-coding-agent's ModelRuntime as a NestJS singleton.
 * Exposes available models for the settings UI and resolves
 * persisted model selections to Model instances.
 */
@Injectable()
export class ModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModelRegistryService.name);
  private runtime: ModelRuntime | null = null;

  async onModuleInit(): Promise<void> {
    try {
      this.runtime = await ModelRuntime.create();
      const error = this.runtime.getError();
      if (error) {
        this.logger.warn(`ModelRuntime loaded with warnings: ${error}`);
      }
    } catch (err) {
      this.logger.error(`Failed to create ModelRuntime: ${err}`);
      // Create an in-memory fallback so the service doesn't crash
      this.runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      });
    }
  }

  /**
   * List all models with availability info for the frontend.
   */
  listModels(): ModelInfo[] {
    const runtime = this.runtime;
    if (!runtime) return [];

    const all = runtime.getModels();
    return all.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      available: runtime.hasConfiguredAuth(m.provider),
    }));
  }

  /**
   * Find and return a Model instance by provider + modelId.
   * Returns undefined if the model is not in the registry.
   */
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.runtime?.getModel(provider, modelId);
  }
}
