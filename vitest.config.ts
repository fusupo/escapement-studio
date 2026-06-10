import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    // This machine locks up when test workers claim every core (vitest
    // defaults to one worker per core, on top of the Studio server, Vite,
    // and any execution-run agents). Keep the suite single-worker.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
