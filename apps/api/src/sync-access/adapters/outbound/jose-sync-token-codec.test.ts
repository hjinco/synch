import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { JoseSyncTokenCodec } from "./jose-sync-token-codec";

const SECRET = "unit-test-secret";
const ISSUER = "synch-api";
const AUDIENCE = "synch-sync";

function claims(overrides: Partial<Awaited<ReturnType<JoseSyncTokenCodec["verifySyncToken"]>>> = {}) {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: "user-1",
		vaultId: "vault-1",
		localVaultId: "local-vault-1",
		displayName: "User",
		scope: "vault:sync" as const,
		iat: now,
		exp: now + 60,
		...overrides,
	};
}

async function rawJwt(payload: Record<string, unknown>): Promise<string> {
	return await new SignJWT(payload)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.sign(new TextEncoder().encode(SECRET));
}

describe("JoseSyncTokenCodec", () => {
	it("signs and verifies a token", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		const token = await codec.signSyncToken(claims());
		await expect(codec.verifySyncToken(token)).resolves.toMatchObject({
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			displayName: "User",
		});
	});

	it("defaults displayName for tokens issued without that claim", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		const now = Math.floor(Date.now() / 1000);
		const token = await rawJwt({
			sub: "user-1",
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			scope: "vault:sync",
			iat: now,
			exp: now + 60,
			iss: ISSUER,
			aud: AUDIENCE,
		});

		await expect(codec.verifySyncToken(token)).resolves.toMatchObject({
			sub: "user-1",
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			displayName: "",
		});
	});

	it("rejects an expired token", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		const token = await codec.signSyncToken(
			claims({ exp: Math.floor(Date.now() / 1000) - 1 }),
		);
		await expect(codec.verifySyncToken(token)).rejects.toMatchObject({ code: "expired_token" });
	});

	it("rejects a malformed token", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		await expect(codec.verifySyncToken("not-a-jwt")).rejects.toMatchObject({ code: "invalid_token" });
	});

	it("rejects a token with the wrong issuer", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		const token = await rawJwt({ ...claims(), iss: "other-issuer" });
		await expect(codec.verifySyncToken(token)).rejects.toMatchObject({ code: "invalid_token" });
	});

	it("rejects a token with missing claims", async () => {
		const codec = new JoseSyncTokenCodec(SECRET);
		const now = Math.floor(Date.now() / 1000);
		const token = await rawJwt({
			sub: "user-1",
			scope: "vault:sync",
			iat: now,
			exp: now + 60,
			iss: ISSUER,
			aud: AUDIENCE,
		});
		await expect(codec.verifySyncToken(token)).rejects.toMatchObject({
			code: "invalid_token_claims",
		});
	});
});
