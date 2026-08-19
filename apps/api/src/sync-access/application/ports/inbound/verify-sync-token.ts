import type { SyncTokenClaims } from "../../dto/token";

export interface VerifySyncToken {
	verifySyncToken(
		token: string | null | undefined,
		expectedVaultId?: string,
	): Promise<SyncTokenClaims>;
}
