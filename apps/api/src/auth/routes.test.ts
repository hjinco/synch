import { describe, expect, it } from "vitest";

import { normalizeDeviceAuthorizationRequest } from "./routes";

const AUTH_ORIGIN = "https://synch.example.com";

function deviceRequest(url: string, headers: Record<string, string> = {}): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify({ client_id: "synch-obsidian-plugin" }),
	});
}

describe("normalizeDeviceAuthorizationRequest", () => {
	it("drops a session cookie left over in the client's cookie jar", () => {
		// Obsidian mobile shares cookies between its in-app browser and requestUrl,
		// and Better Auth rejects these endpoints outright when a cookie rides along.
		const normalized = normalizeDeviceAuthorizationRequest(
			deviceRequest("https://synch.example.com/api/auth/device/code", {
				cookie: "better-auth.session_token=stale",
				origin: "app://obsidian.md",
			}),
			AUTH_ORIGIN,
		);

		expect(normalized.headers.get("cookie")).toBeNull();
		expect(normalized.headers.get("origin")).toBe("https://synch.example.com");
		expect(normalized.headers.get("referer")).toBe("https://synch.example.com/device");
	});

	it("drops cookies on the token endpoint too", () => {
		const normalized = normalizeDeviceAuthorizationRequest(
			deviceRequest("https://synch.example.com/api/auth/device/token", {
				cookie: "unrelated=value",
			}),
			AUTH_ORIGIN,
		);

		expect(normalized.headers.get("cookie")).toBeNull();
	});

	it("keeps the request body intact", async () => {
		const normalized = normalizeDeviceAuthorizationRequest(
			deviceRequest("https://synch.example.com/api/auth/device/code", {
				cookie: "better-auth.session_token=stale",
			}),
			AUTH_ORIGIN,
		);

		await expect(normalized.json()).resolves.toEqual({
			client_id: "synch-obsidian-plugin",
		});
	});

	it("leaves cookies on other auth requests", () => {
		const request = deviceRequest("https://synch.example.com/api/auth/sign-in/email", {
			cookie: "better-auth.session_token=live",
		});

		const normalized = normalizeDeviceAuthorizationRequest(request, AUTH_ORIGIN);

		expect(normalized).toBe(request);
		expect(normalized.headers.get("cookie")).toBe("better-auth.session_token=live");
	});

	it("leaves non-POST device requests untouched", () => {
		const request = new Request("https://synch.example.com/api/auth/device/code", {
			method: "GET",
			headers: { cookie: "better-auth.session_token=live" },
		});

		expect(normalizeDeviceAuthorizationRequest(request, AUTH_ORIGIN)).toBe(request);
	});

	it("pins the origin to PUBLIC_URL when a TLS-terminating proxy hands over http", () => {
		// nginx terminates TLS and proxies to the container over plain http, so the
		// request URL arrives on http even though clients reached it over https.
		const normalized = normalizeDeviceAuthorizationRequest(
			deviceRequest("http://synch.example.com/api/auth/device/code", {
				origin: "app://obsidian.md",
			}),
			AUTH_ORIGIN,
		);

		expect(normalized.headers.get("origin")).toBe("https://synch.example.com");
		expect(normalized.headers.get("referer")).toBe("https://synch.example.com/device");
	});
});
