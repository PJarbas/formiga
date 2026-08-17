import { defineConfig } from "vitest/config";
import path from "node:path";

// Root vitest config for the src suites that use vitest (12 files: dashboard
// lib helpers, mcp server/tools, leaderboard & dashboard-store schemas).
// The dashboard's own vite.config.ts only applies to `vite build`, not to
// `vitest run` from the repo root, so the `@shared` alias is re-declared here.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/dashboard-store/**/*.test.ts",
      "src/dashboard/src/lib/**/*.test.ts",
      "src/leaderboard/schema.test.ts",
      "src/mcp/**/*.test.ts",
    ],
  },
});
