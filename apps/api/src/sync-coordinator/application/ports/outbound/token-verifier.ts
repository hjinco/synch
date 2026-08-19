import type { SyncTokenClaims } from "../../../../sync-access/application";

export interface SyncTokenVerifier {
	verifySyncToken(
		token: string | null | undefined,
		expectedVaultId?: string,
	): Promise<SyncTokenClaims>;
}
