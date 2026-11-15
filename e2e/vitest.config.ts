import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    setupFiles: ["src/print-on-failure.ts"],
    // Each test starts real processes; a hung one must fail, not stall the run.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
