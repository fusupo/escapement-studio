export interface AppConfig {
  port: number;
  manifestPath: string;
  planningSessionDir: string;
}

export function getConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    manifestPath: process.env.MANIFEST_PATH ?? ".manifest",
    planningSessionDir: process.env.PLANNING_SESSION_DIR ?? ".studio/planning/sessions",
  };
}
