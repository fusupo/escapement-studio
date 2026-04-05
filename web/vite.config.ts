import { defineConfig, loadEnv } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBaseUrl = env.STUDIO_API_URL || "http://localhost:3000";

  return {
  root: "web",
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiBaseUrl,
      "/health": apiBaseUrl,
    },
  },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  };
});
