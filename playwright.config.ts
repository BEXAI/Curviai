import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @curvi/web build && pnpm --filter @curvi/web start -- --port 3100",
    url: "http://localhost:3100",
    timeout: 300000,
    reuseExistingServer: !process.env.CI,
  },
});
