import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The web app's alias, for apps/web/src/lib/marketing-facts.ts (the
      // live channel list the listing is checked against).
      "@": fileURLToPath(new URL("../../apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
