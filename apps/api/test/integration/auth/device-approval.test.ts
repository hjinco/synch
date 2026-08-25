import { describe, expect, it } from "vitest";

import {
	DEFAULT_VAULT_WRAPPER,
	jsonRequest,
	signUpAccount,
} from "../../helpers/api";
import { apiAuthPageHeaders, expectDeviceVerificationUrl } from "./helpers";

describe("auth device approval integration", () => {
	it("supports device approval through the verifier page", async () => {
		const deviceCode = await jsonRequest<{
			device_code: string;
			user_code: string;
			verification_uri: string;
			verification_uri_complete: string;
			expires_in: number;
			interval: number;
		}>("/api/auth/device/code", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "null",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({
				client_id: "synch-obsidian-plugin",
			}),
		});

		expect(deviceCode.response.status).toBe(200);
		expect(deviceCode.json?.device_code).toBeTruthy();
		expect(deviceCode.json?.user_code).toBeTruthy();
		expectDeviceVerificationUrl(deviceCode.json?.verification_uri);
		const completeVerificationUrl = expectDeviceVerificationUrl(
			deviceCode.json?.verification_uri_complete,
		);
		expect(completeVerificationUrl.searchParams.get("user_code")).toBe(
			deviceCode.json?.user_code,
		);
		expect(deviceCode.json?.expires_in).toBeGreaterThan(0);
		expect(deviceCode.json?.interval).toBeGreaterThan(0);

		const account = await signUpAccount({
			name: "Verifier User",
			email: `device-${crypto.randomUUID()}@example.com`,
		});
		const browserSessionCookie = account.sessionCookie;

		const verifiedDevice = await jsonRequest<{ user_code: string; status: string }>(
			`/api/auth/device?user_code=${deviceCode.json?.user_code}`,
			{
				headers: {
					cookie: browserSessionCookie,
					...apiAuthPageHeaders(),
				},
			},
		);
		expect(verifiedDevice.response.status).toBe(200);
		expect(verifiedDevice.json?.status).toBe("pending");

		const vaultName = `device-vault-${crypto.randomUUID()}`;
		const createVaultResponse = await jsonRequest<{ vault: { id: string; name: string } }>(
			"/v1/vaults",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: browserSessionCookie,
				},
				body: JSON.stringify({
					name: vaultName,
					initialWrapper: DEFAULT_VAULT_WRAPPER,
				}),
			},
		);
		expect(createVaultResponse.response.status).toBe(201);
		expect(createVaultResponse.json?.vault.name).toBe(vaultName);
		const vaultId = createVaultResponse.json?.vault.id ?? "";
		expect(vaultId).toBeTruthy();

		const approveResponse = await jsonRequest<{ success: boolean }>("/api/auth/device/approve", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: browserSessionCookie,
				...apiAuthPageHeaders(),
			},
			body: JSON.stringify({
				userCode: deviceCode.json?.user_code ?? "",
			}),
		});
		expect(approveResponse.response.status).toBe(200);
		expect(approveResponse.json?.success).toBe(true);

		const approvedDevice = await jsonRequest<{ user_code: string; status: string }>(
			`/api/auth/device?user_code=${deviceCode.json?.user_code}`,
			{
				headers: {
					...apiAuthPageHeaders(),
				},
			},
		);
		expect(approvedDevice.response.status).toBe(200);
		expect(approvedDevice.json?.status).toBe("approved");

		const tokenResponse = await jsonRequest<{
			access_token: string;
			expires_in: number;
			scope: string;
		}>("/api/auth/device/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "null",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode.json?.device_code,
				client_id: "synch-obsidian-plugin",
			}),
		});

		expect(tokenResponse.response.status).toBe(200);
		expect(tokenResponse.json?.access_token).toBeTruthy();
		expect(tokenResponse.json?.expires_in).toBeGreaterThan(0);

		const syncTokenResponse = await jsonRequest<{
			token: string;
			expiresAt: number;
			vaultId: string;
			localVaultId: string;
			syncFormatVersion: number;
		}>("/v1/sync/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${tokenResponse.json?.access_token ?? ""}`,
			},
			body: JSON.stringify({
				vaultId,
				localVaultId: "obsidian-local-vault",
			}),
		});
		expect(syncTokenResponse.response.status).toBe(200);
		expect(syncTokenResponse.json?.token).toBeTruthy();
		expect(syncTokenResponse.json?.vaultId).toBe(vaultId);
		expect(syncTokenResponse.json?.syncFormatVersion).toBe(2);
	});
});
