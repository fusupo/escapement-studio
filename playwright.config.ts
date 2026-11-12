import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./web/tests", fullyParallel: false, workers: 1,
  use: { baseURL: "http://127.0.0.1:4175", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: "npm run dev:web -- --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175", reuseExistingServer: false,
  },
});
