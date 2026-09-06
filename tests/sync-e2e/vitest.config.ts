import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["scenarios/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 120_000 },
});
