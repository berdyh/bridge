import { defineConfig } from "vitest/config";
import { aliases } from "./aliases.js";
import { scratchRoot } from "./scratch.mjs";

export default defineConfig({
  cacheDir: `${scratchRoot()}/vite`,
  resolve: { alias: aliases },
  test: { include: ["src/**/*.test.ts"], fileParallelism: false, maxWorkers: 1,
    testTimeout: 180_000, hookTimeout: 100_000 },
});
