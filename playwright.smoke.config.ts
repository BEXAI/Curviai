import { defineConfig } from "@playwright/test";
import { smokeSettings } from "./e2e/smoke/settings";

const settings = smokeSettings(process.env);

// Existing deployment only. No implicit build, server, credentials or paid run.
export default defineConfig({
  testDir: "./e2e/smoke",
  testMatch: "**/*.smoke.ts",
  timeout: 120_000,
  workers: 1,
  retries: 0, // A failed paid pack is investigated, never automatically purchased again.
  reporter: "list",
  use: {
    baseURL: settings.baseURL,
    actionTimeout: 30_000,
    navigationTimeout: 90_000, // Free staging can need a cold start.
    trace: "off", // Auth headers, passwords and signed files never enter a trace.
    screenshot: "off",
    video: "off",
  },
});
