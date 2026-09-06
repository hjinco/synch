import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.integration.test.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 } });
