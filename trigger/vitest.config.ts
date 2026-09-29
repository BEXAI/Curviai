import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // PGlite test databases run every migration in beforeAll, which can pass
    // 10 s when the machine is loaded.
    hookTimeout: 60_000,
  },
});
