import { afterEach, describe, expect, it } from "vitest";

import {
	requireOriginEnv,
	requireUrlEnv,
	resolveOriginBinding,
	resolveUrlBinding,
} from "./env";

const originalEnv = { ...process.env };

describe("env config", () => {
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns trimmed URL values and origin values", () => {
		process.env.TEST_URL = " https://www.example.com/app ";

		expect(requireUrlEnv("TEST_URL")).toBe("https://www.example.com/app");
		expect(requireOriginEnv("TEST_URL")).toBe("https://www.example.com");
	});

	it("rejects missing or invalid URL values", () => {
		delete process.env.TEST_URL;
		expect(() => requireUrlEnv("TEST_URL")).toThrow(
			expect.objectContaining({ code: "env_required", envName: "TEST_URL" }),
		);

		process.env.TEST_URL = "not-a-url";
		expect(() => requireUrlEnv("TEST_URL")).toThrow(
			expect.objectContaining({ code: "env_invalid_url", envName: "TEST_URL" }),
		);
	});

	it("falls back to the request URL for missing URL bindings", () => {
		const fallback = "https://api.example.com/vaults";

		expect(resolveUrlBinding("TEST_URL", undefined, fallback)).toBe(fallback);
		expect(resolveOriginBinding("TEST_URL", undefined, fallback)).toBe("https://api.example.com");
	});

	it("prefers configured URL bindings over the fallback URL", () => {
		const fallback = "https://api.example.com/vaults";

		expect(resolveUrlBinding("TEST_URL", " https://www.example.com/app ", fallback)).toBe(
			"https://www.example.com/app",
		);
		expect(resolveOriginBinding("TEST_URL", " https://www.example.com/app ", fallback)).toBe(
			"https://www.example.com",
		);
	});
});
