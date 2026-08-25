import { describe, expect, it } from "vitest";

import { jsonRequest, signUpAccount } from "../../helpers/api";
import { apiAuthPageHeaders } from "./helpers";

describe("auth device denial integration", () => {
	it("supports device denial and reports invalid verifier codes", async () => {
		const account = await signUpAccount();
		const deviceCode = await jsonRequest<{
			device_code: string;
			user_code: string;
		}>("/api/auth/device/code", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				client_id: "synch-obsidian-plugin",
			}),
		});

		const verifiedDevice = await jsonRequest<{ user_code: string; status: string }>(
			`/api/auth/device?user_code=${deviceCode.json?.user_code}`,
			{
				headers: {
					cookie: account.sessionCookie,
					...apiAuthPageHeaders(),
				},
			},
		);
		expect(verifiedDevice.response.status).toBe(200);
		expect(verifiedDevice.json?.status).toBe("pending");

		const denyResponse = await jsonRequest<{ success: boolean }>("/api/auth/device/deny", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: account.sessionCookie,
				...apiAuthPageHeaders(),
			},
			body: JSON.stringify({
				userCode: deviceCode.json?.user_code ?? "",
			}),
		});
		expect(denyResponse.response.status).toBe(200);
		expect(denyResponse.json?.success).toBe(true);

		const deniedDevice = await jsonRequest<{ user_code: string; status: string }>(
			`/api/auth/device?user_code=${deviceCode.json?.user_code}`,
			{
				headers: {
					...apiAuthPageHeaders(),
				},
			},
		);
		expect(deniedDevice.response.status).toBe(200);
		expect(deniedDevice.json?.status).toBe("denied");

		const deniedToken = await jsonRequest<{
			error: string;
			error_description: string;
		}>("/api/auth/device/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode.json?.device_code,
				client_id: "synch-obsidian-plugin",
			}),
		});
		expect(deniedToken.response.status).toBe(400);
		expect(deniedToken.json?.error).toBe("access_denied");

		const invalidDevice = await jsonRequest<{
			error: string;
			error_description: string;
		}>("/api/auth/device?user_code=NOTREAL00", {
			headers: {
				...apiAuthPageHeaders(),
			},
		});
		expect(invalidDevice.response.status).toBe(400);
		expect(invalidDevice.json?.error).toBe("invalid_request");

		const invalidToken = await jsonRequest<{
			error: string;
			error_description: string;
		}>("/api/auth/device/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: "missing-device-code",
				client_id: "synch-obsidian-plugin",
			}),
		});
		expect(invalidToken.response.status).toBe(400);
		expect(invalidToken.json?.error).toBe("invalid_grant");
	});
});
