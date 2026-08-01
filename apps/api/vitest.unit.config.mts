import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "test/self-host/**/*.test.ts"],
		testTimeout: 20_000,
	},
});
