import { Inject, Injectable } from "@nestjs/common";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SQLiteService } from "../../platform/sqlite.service.js";
import { getConfig } from "../../config.js";
import { ModelRegistryService } from "./model-registry.service.js";

export interface RepoSettings {
  default_branch: string;
  included: boolean;
}

export interface SelectedModel {
  provider: string;
  modelId: string;
}

export interface SettingsConfig {
  manifestPath: string;
  planningSessionDir: string;
  artifactRoot: string;
  selectedModel: SelectedModel | null;
}

export interface SettingsPayload {
  repos: Record<string, RepoSettings>;
  config: SettingsConfig;
}

export interface SettingsUpdate {
  repos?: Record<string, RepoSettings>;
  config?: Partial<SettingsConfig>;
}

const SETTINGS_KEY = "studio_settings";

@Injectable()
export class SettingsService {
  constructor(
    @Inject(SQLiteService) private readonly sqlite: SQLiteService,
    @Inject(ModelRegistryService) private readonly modelRegistry: ModelRegistryService,
  ) {}

  getSettings(): SettingsPayload {
    const db = this.sqlite.getDb();
    const row = db
      .prepare("SELECT value FROM studio_metadata WHERE key = ?")
      .get(SETTINGS_KEY) as { value: string } | undefined;

    if (row) {
      try {
        const stored = JSON.parse(row.value) as Partial<SettingsPayload>;
        // Merge with live config so new fields always appear
        return this.mergeWithDefaults(stored);
      } catch {
        // Corrupted — fall through to defaults
      }
    }

    return this.defaults();
  }

  updateSettings(payload: SettingsUpdate): SettingsPayload {
    const current = this.getSettings();

    // Merge repos
    if (payload.repos !== undefined) {
      current.repos = {};
      for (const [slug, info] of Object.entries(payload.repos)) {
        current.repos[slug] = {
          default_branch: info.default_branch || "main",
          included: info.included !== false,
        };
      }
    }

    // Merge config (only the fields we allow editing)
    if (payload.config) {
      if (payload.config.manifestPath !== undefined) {
        current.config.manifestPath = payload.config.manifestPath;
      }
      if (payload.config.planningSessionDir !== undefined) {
        current.config.planningSessionDir = payload.config.planningSessionDir;
      }
      if (payload.config.artifactRoot !== undefined) {
        current.config.artifactRoot = payload.config.artifactRoot;
      }
      if (payload.config.selectedModel !== undefined) {
        current.config.selectedModel = payload.config.selectedModel;
      }
    }

    const db = this.sqlite.getDb();
    db.prepare(
      `INSERT INTO studio_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(SETTINGS_KEY, JSON.stringify(current));

    return current;
  }

  /**
   * Resolve the persisted model selection to a pi-ai Model instance.
   * Returns undefined when no model is selected or the selection doesn't
   * match any model in the registry — callers should let pi use its default.
   */
  getSelectedModel(): Model<Api> | undefined {
    const { config } = this.getSettings();
    if (!config.selectedModel) return undefined;
    return this.modelRegistry.find(config.selectedModel.provider, config.selectedModel.modelId);
  }

  /**
   * Get the default working branch for a repo, consulting settings first,
   * then falling back to the hardcoded defaults.
   */
  getDefaultBranch(repo?: string | null): string {
    if (!repo) return "main";
    const settings = this.getSettings();
    const repoInfo = settings.repos[repo];
    if (repoInfo?.default_branch) {
      return repoInfo.default_branch;
    }
    return "main";
  }

  /**
   * Get all configured repo → branch mappings for the execution system.
   */
  listDefaultBranches(): Record<string, string> {
    const settings = this.getSettings();
    const result: Record<string, string> = {};
    for (const [slug, info] of Object.entries(settings.repos)) {
      if (info.included !== false) {
        result[slug] = info.default_branch || "main";
      }
    }
    return result;
  }

  /**
   * Get included repo slugs.
   */
  listIncludedRepos(): string[] {
    const settings = this.getSettings();
    return Object.entries(settings.repos)
      .filter(([, info]) => info.included !== false)
      .map(([slug]) => slug);
  }

  private defaults(): SettingsPayload {
    const appConfig = getConfig();
    return {
      repos: {
        "fusupo/escapement-studio": {
          default_branch: "develop",
          included: true,
        },
      },
      config: {
        manifestPath: appConfig.manifestPath,
        planningSessionDir: appConfig.planningSessionDir,
        artifactRoot: appConfig.artifactRoot,
        selectedModel: null,
      },
    };
  }

  private mergeWithDefaults(stored: Partial<SettingsPayload>): SettingsPayload {
    const defaults = this.defaults();
    return {
      repos: stored.repos ?? defaults.repos,
      config: {
        manifestPath: stored.config?.manifestPath ?? defaults.config.manifestPath,
        planningSessionDir: stored.config?.planningSessionDir ?? defaults.config.planningSessionDir,
        artifactRoot: stored.config?.artifactRoot ?? defaults.config.artifactRoot,
        selectedModel: stored.config?.selectedModel ?? defaults.config.selectedModel,
      },
    };
  }
}
