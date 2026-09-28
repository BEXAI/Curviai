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
    // next start runs with NODE_ENV=production, where demo mode fails closed
    // unless ALLOW_DEMO_MODE=1. The e2e suite runs the demo build on purpose.
    command: "pnpm --filter @curvi/web build && ALLOW_DEMO_MODE=1 PORT=3100 pnpm --filter @curvi/web start",
    url: "http://localhost:3100",
    timeout: 300000,
    reuseExistingServer: !process.env.CI,
  },
});
