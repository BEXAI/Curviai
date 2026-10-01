import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "eval/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
