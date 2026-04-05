import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const apiBaseUrl = process.env.STUDIO_API_URL ?? "http://localhost:3000";

export default defineConfig({
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
});
