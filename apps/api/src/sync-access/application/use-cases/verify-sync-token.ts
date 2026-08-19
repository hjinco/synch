import { SyncAccessApplicationError } from "../errors/sync-access-errors";
import type { VerifySyncToken } from "../ports/inbound/verify-sync-token";
import type { SyncTokenCodec } from "../ports/outbound/sync-token-codec";
import type { SyncTokenClaims } from "../dto/token";

export class VerifySyncTokenUseCase implements VerifySyncToken {
	constructor(private readonly syncTokenCodec: Pick<SyncTokenCodec, "verifySyncToken">) {}

	async verifySyncToken(
		token: string | null | undefined,
		expectedVaultId?: string,
	): Promise<SyncTokenClaims> {
		if (!token) {
			throw new SyncAccessApplicationError("missing_token");
		}

		const claims = await this.syncTokenCodec.verifySyncToken(token);
		if (claims.scope !== "vault:sync") {
			throw new SyncAccessApplicationError("invalid_scope");
		}
		if (expectedVaultId && claims.vaultId !== expectedVaultId) {
			throw new SyncAccessApplicationError("vault_mismatch");
		}
		return claims;
	}
}
