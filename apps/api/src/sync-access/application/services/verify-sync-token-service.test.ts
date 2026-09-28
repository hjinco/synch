import { expect, it, vi } from "vitest";
import { VerifySyncTokenService } from "./sync-token-service";
import type { SyncTokenClaims } from "../dto/token";

const claims: SyncTokenClaims = {
	sub: "user",
	vaultId: "vault",
	localVaultId: "device",
	displayName: "User",
	scope: "vault:sync",
	iat: 1,
	exp: 9999999999,
	accessVersion: 3,
};
it.each(["signature", "scope", "vault"])(
	"does not send unverified identity to the trusted coordinator (%s)",
	async (failure) => {
		const codec = {
			verifySyncToken: vi.fn(async () => {
				if (failure === "signature") throw new Error("bad signature");
				return failure === "scope"
					? ({ ...claims, scope: "other" } as unknown as SyncTokenClaims)
					: claims;
			}),
		};
		const authorize = vi.fn();
		const service = new VerifySyncTokenService(codec, authorize);
		await expect(
			service.verifySyncToken(
				"token",
				failure === "vault" ? "foreign" : "vault",
			),
		).rejects.toBeDefined();
		expect(authorize).not.toHaveBeenCalled();
	},
);
it("checks the current access version after authentication and propagates revocation", async () => {
	const denial = new Error("revoked");
	const authorize = vi.fn(async () => {
		throw denial;
	});
	const service = new VerifySyncTokenService(
		{ verifySyncToken: async () => claims },
		authorize,
	);
	await expect(service.verifySyncToken("token", "vault")).rejects.toBe(denial);
	expect(authorize).toHaveBeenCalledWith(claims, "token");
});
