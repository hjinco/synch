import { describe, expect, it } from "vitest";

import { VerifySyncTokenUseCase } from "../../../application/use-cases/verify-sync-token";
import { JoseSyncTokenCodec } from "../../outbound/jose-sync-token-codec";
import { createRequestTokenVerifier, readSyncTokenFromRequest } from "./request-auth";

const SECRET = "unit-test-secret";

describe("sync token request authentication", () => {
	it("prefers the bearer token over websocket auth protocol", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		const verifier = createRequestTokenVerifier(new VerifySyncTokenUseCase(codec));
		const bearer = await codec.signSyncToken({
			sub: "user-1",
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			displayName: "User",
			scope: "vault:sync",
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const protocol = await codec.signSyncToken({
			sub: "user-1",
			vaultId: "vault-2",
			localVaultId: "local-vault-1",
			displayName: "User",
			scope: "vault:sync",
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const request = new Request("https://example.com", {
			headers: {
				authorization: `Bearer ${bearer}`,
				"sec-websocket-protocol": `synch.v1, synch.auth.${protocol}`,
			},
		});

		expect(readSyncTokenFromRequest(request)).toBe(bearer);
		await expect(verifier.requireSyncToken(request, "vault-1")).resolves.toMatchObject({
			vaultId: "vault-1",
		});
	});

	it("reads a websocket auth protocol when bearer auth is unavailable", () => {
		const request = new Request("https://example.com", {
			headers: { "sec-websocket-protocol": "synch.v1, synch.auth.token" },
		});
		expect(readSyncTokenFromRequest(request)).toBe("token");
	});
});
