import { errors as joseErrors, jwtVerify, SignJWT } from "jose";

import { parseSyncTokenClaimValues } from "../../domain/token-policy";
import { SyncAccessApplicationError } from "../../application/errors/sync-access-errors";
import type { SyncTokenClaims } from "../../application/dto/token";
import type { SyncTokenCodec } from "../../application/ports/outbound/sync-token-codec";
import {
	SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
	SYNC_WEBSOCKET_PROTOCOL,
} from "../../application/dto/token";

const SYNC_TOKEN_ALGORITHM = "HS256";
const SYNC_TOKEN_ISSUER = "synch-api";
const SYNC_TOKEN_AUDIENCE = "synch-sync";

export class JoseSyncTokenCodec implements SyncTokenCodec {
	constructor(private readonly secret: string) {}

	async signSyncToken(claims: SyncTokenClaims): Promise<string> {
		return await new SignJWT({
			vaultId: claims.vaultId,
			localVaultId: claims.localVaultId,
			displayName: claims.displayName,
			scope: claims.scope,
		})
			.setProtectedHeader({
				alg: SYNC_TOKEN_ALGORITHM,
				typ: "JWT",
			})
			.setIssuer(SYNC_TOKEN_ISSUER)
			.setAudience(SYNC_TOKEN_AUDIENCE)
			.setSubject(claims.sub)
			.setIssuedAt(claims.iat)
			.setExpirationTime(claims.exp)
			.sign(new TextEncoder().encode(this.secret));
	}

	async verifySyncToken(token: string): Promise<SyncTokenClaims> {
		try {
			const { payload } = await jwtVerify(token, new TextEncoder().encode(this.secret), {
				algorithms: [SYNC_TOKEN_ALGORITHM],
				issuer: SYNC_TOKEN_ISSUER,
				audience: SYNC_TOKEN_AUDIENCE,
			});
			const claims = parseSyncTokenClaimValues(payload);
			if (!claims) {
				throw new SyncAccessApplicationError("invalid_token_claims");
			}
			return claims;
		} catch (error) {
			if (error instanceof SyncAccessApplicationError) {
				throw error;
			}
			if (error instanceof joseErrors.JWTExpired) {
				throw new SyncAccessApplicationError("expired_token");
			}
			throw new SyncAccessApplicationError("invalid_token");
		}
	}
}

export {
	SYNC_TOKEN_AUDIENCE,
	SYNC_TOKEN_ISSUER,
	SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
	SYNC_WEBSOCKET_PROTOCOL,
};
