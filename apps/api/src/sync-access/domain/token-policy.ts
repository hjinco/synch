export type SyncTokenClaimValues = {
	sub: string;
	vaultId: string;
	localVaultId: string;
	displayName: string;
	scope: "vault:sync";
	iat: number;
	exp: number;
};

/**
 * Mirrors the existing JWT claim validation without bringing a schema/runtime
 * dependency into the domain layer. JWT decoding and error translation remain
 * in the Jose adapter.
 */
export function parseSyncTokenClaimValues(value: unknown): SyncTokenClaimValues | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const claims = value as Record<string, unknown>;
	if (
		typeof claims.sub !== "string" ||
		typeof claims.vaultId !== "string" ||
		typeof claims.localVaultId !== "string" ||
		claims.scope !== "vault:sync" ||
		typeof claims.iat !== "number" ||
		typeof claims.exp !== "number" ||
		!Number.isInteger(claims.iat) ||
		!Number.isInteger(claims.exp)
	) {
		return null;
	}

	const sub = claims.sub.trim();
	const vaultId = claims.vaultId.trim();
	const localVaultId = claims.localVaultId.trim();
	if (!sub || !vaultId || !localVaultId) {
		return null;
	}

	return {
		sub,
		vaultId,
		localVaultId,
		displayName: typeof claims.displayName === "string" ? claims.displayName.trim() : "",
		scope: "vault:sync",
		iat: claims.iat,
		exp: claims.exp,
	};
}
