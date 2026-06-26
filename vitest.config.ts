import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vitest config covers both Node-side tests (schemas, server logic) and
// React component tests under src/dashboard. The `environmentMatchGlobs`
// option routes *.tsx tests to jsdom while keeping plain .ts tests on Node.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    globals: false,
    environmentMatchGlobs: [
      ["src/dashboard/**/*.tsx", "jsdom"],
      ["src/dashboard/**/*.ts", "jsdom"],
    ],
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
