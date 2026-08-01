import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

loadEnv({ path: "./.env" });

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(path.join(__dirname, "drizzle"));

			return {
				main: "./src/index.ts",
				wrangler: {
					configPath: "./wrangler.jsonc",
					environment: "managed",
				},
				miniflare: {
					d1Databases: {
						DB: "00000000-0000-0000-0000-000000000001",
					},
					bindings: {
						BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
						WWW_BASE_URL: process.env.WWW_BASE_URL ?? "http://localhost:4321",
						BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
						SYNC_TOKEN_SECRET: process.env.SYNC_TOKEN_SECRET,
						SELF_HOSTED: false,
						DEV_MODE: false,
						AUTH_EMAIL_FROM: "Synch <noreply@example.com>",
						TEST_MIGRATIONS: migrations,
					},
				},
			};
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		// self-host tests boot a real Node process (native better-sqlite3/ws
		// bindings, raw net sockets) and run under vitest.unit.config.mts's
		// plain node environment instead - they can't run inside the
		// Miniflare/workerd sandbox this config uses.
		exclude: ["test/self-host/**"],
		setupFiles: ["./test/setup.ts"],
		testTimeout: 20_000,
	},
});
