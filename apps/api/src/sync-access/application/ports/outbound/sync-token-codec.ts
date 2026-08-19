import type { SyncTokenClaims } from "../../dto/token";

export interface SyncTokenCodec {
	signSyncToken(claims: SyncTokenClaims): Promise<string>;
	verifySyncToken(token: string): Promise<SyncTokenClaims>;
}
