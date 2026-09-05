import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
      includeSamples: true,
    },
  },
});
