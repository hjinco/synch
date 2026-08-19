import type { SyncTokenClaimValues } from "../../domain/token-policy";

export type SyncTokenClaims = SyncTokenClaimValues;

export type SyncTokenIssueInput = {
	userId: string;
	vaultId: string;
	localVaultId: string;
};

export type SyncTokenIssueResponse = {
	token: string;
	expiresAt: number;
	vaultId: string;
	localVaultId: string;
	syncFormatVersion: number;
};

export const SYNC_WEBSOCKET_PROTOCOL = "synch.v1";
export const SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX = "synch.auth.";

/** Parses only the bearer value; HTTP header access belongs to adapters. */
export function parseBearerToken(authorization: string | null | undefined): string | null {
	if (!authorization?.startsWith("Bearer ")) {
		return null;
	}

	const token = authorization.slice("Bearer ".length);
	return token || null;
}
