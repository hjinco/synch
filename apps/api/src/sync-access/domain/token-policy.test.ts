import { describe, expect, it } from "vitest";

import { parseSyncTokenClaimValues } from "./token-policy";

describe("parseSyncTokenClaimValues", () => {
	it("defaults a missing displayName", () => {
		expect(
			parseSyncTokenClaimValues({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync",
				iat: 1,
				exp: 2,
			}),
		).toEqual({
			sub: "user-1",
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			displayName: "",
			scope: "vault:sync",
			iat: 1,
			exp: 2,
		});
	});

	it("trims displayName", () => {
		expect(
			parseSyncTokenClaimValues({
				sub: "ada",
				vaultId: "vault-1",
				localVaultId: "phone",
				displayName: "  Ada  ",
				scope: "vault:sync",
				iat: 1,
				exp: 2,
			}),
		).toMatchObject({
			displayName: "Ada",
		});
	});
});
