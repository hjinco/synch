import { describe, expect, it } from "vitest";

import { parseBooleanBinding, readCloudflareProfile } from "./cloudflare";

describe("Cloudflare config", () => {
	it("maps the legacy SELF_HOSTED binding to an explicit deployment profile", () => {
		expect(readCloudflareProfile({ SELF_HOSTED: true })).toEqual({
			platform: "cloudflare",
			edition: "community",
		});
		expect(readCloudflareProfile({ SELF_HOSTED: false })).toEqual({
			platform: "cloudflare",
			edition: "managed",
		});
	});

	it("parses supported boolean binding representations", () => {
		expect(parseBooleanBinding("FLAG", "true", false)).toBe(true);
		expect(parseBooleanBinding("FLAG", "1", false)).toBe(true);
		expect(parseBooleanBinding("FLAG", "false", true)).toBe(false);
		expect(parseBooleanBinding("FLAG", "0", true)).toBe(false);
		expect(parseBooleanBinding("FLAG", undefined, true)).toBe(true);
	});

	it("rejects ambiguous boolean bindings", () => {
		expect(() => parseBooleanBinding("FLAG", "yes", false)).toThrow();
	});
});
