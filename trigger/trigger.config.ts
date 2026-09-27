/**
 * Trigger.dev v3 project config. The project ref comes from the
 * TRIGGER_PROJECT_ID env var; the placeholder keeps typechecking and local
 * tooling working with zero env configured, and the CLI reports a clear
 * error if a deploy is attempted without a real ref.
 */

import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID ?? "proj_curvi_placeholder",
  dirs: ["./src/tasks"],
  // Compute time ceiling per run, in seconds. Pack jobs wait on per shot
  // subtasks, so 30 minutes is generous headroom; tasks set tighter values.
  maxDuration: 1_800,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});
