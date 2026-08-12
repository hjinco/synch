import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
	MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION,
	SYNCH_API_MAJOR_VERSION,
} from "./policy";
import { registerPluginVersionRoutes } from "./routes";

describe("plugin version routes", () => {
	it("returns ok for a supported Obsidian plugin version", async () => {
		const app = createTestApp();

		const response = await app.request(
			`/v1/obsidian-plugin/version-check?version=${MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION}`,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			status: "ok",
			minVersion: MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION,
			apiMajor: SYNCH_API_MAJOR_VERSION,
		});
	});

	it("returns update_required for an unsupported Obsidian plugin version", async () => {
		const app = createTestApp();

		const response = await app.request(
			`/v1/obsidian-plugin/version-check?version=${versionBelow(
				MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION,
			)}`,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			status: "update_required",
			minVersion: MIN_SUPPORTED_OBSIDIAN_PLUGIN_VERSION,
			apiMajor: SYNCH_API_MAJOR_VERSION,
		});
	});

	it("rejects malformed versions", async () => {
		const app = createTestApp();

		const response = await app.request(
			"/v1/obsidian-plugin/version-check?version=0.0.8-beta.1",
		);

		expect(response.status).toBe(400);
	});
});

function createTestApp(): Hono {
	const app = new Hono();
	registerPluginVersionRoutes(app);
	return app;
}

// Returns a strict x.y.z version just below the given one, so the
// "update required" case stays valid if the minimum version changes.
function versionBelow(version: string): string {
	const parts = version.split(".").map(Number);
	const lastNonZero = parts.findLastIndex((part) => part > 0);
	if (lastNonZero < 0) {
		throw new Error(`No version exists below ${version}`);
	}

	return parts
		.map((part, index) => {
			if (index < lastNonZero) return part;
			return index === lastNonZero ? part - 1 : 0;
		})
		.join(".");
}
