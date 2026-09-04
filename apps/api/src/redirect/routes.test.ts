import { describe, expect, it } from "vitest";

import { getLoopbackTarget } from "./routes";

describe("localhost redirect target", () => {
	it("accepts loopback HTTP(S) URLs with their query intact", () => {
		expect(
			getLoopbackTarget(
				"http://localhost:8787/device?user_code=ABC&return_uri=obsidian%3A%2F%2Fsynch-device-login",
			),
		).toEqual(
			new URL(
				"http://localhost:8787/device?user_code=ABC&return_uri=obsidian%3A%2F%2Fsynch-device-login",
			),
		);
	});

	it("rejects non-loopback or non-HTTP(S) targets", () => {
		expect(getLoopbackTarget("https://example.com/device")).toBeNull();
		expect(getLoopbackTarget("javascript:alert(1)")).toBeNull();
		expect(getLoopbackTarget("http://localhost:8787@evil.example/device")).toBeNull();
		expect(getLoopbackTarget("http://localhost:8787/admin")).toBeNull();
	});
});
