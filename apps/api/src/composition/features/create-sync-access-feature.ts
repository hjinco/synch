import type { SyncTokenClaims } from "../../sync-access/application/dto/token";
import type { VaultService } from "../../vault/application";
import type { IssueSyncToken, VerifySyncToken } from "../../sync-access/application";
import { CoordinatorSyncPauseReader, type CoordinatorNamespace } from "../../sync-access/adapters/outbound/coordinator-sync-pause-reader";
import { createRequestTokenVerifier, selectSyncWebSocketProtocol } from "../../sync-access/adapters/inbound/http/request-auth";
import { JoseSyncTokenCodec } from "../../sync-access/adapters/outbound/jose-sync-token-codec";
import {
	IssueSyncTokenService,
	VerifySyncTokenService,
} from "../../sync-access/application/services/sync-token-service";

export type SyncAccessFeature = {
	tokenIssuer: IssueSyncToken;
	tokenVerifier: VerifySyncToken;
	requestTokenVerifier: ReturnType<typeof createRequestTokenVerifier>;
	selectSyncWebSocketProtocol: typeof selectSyncWebSocketProtocol;
};

export type SyncTokenFeature = Omit<SyncAccessFeature, "tokenIssuer">;

export function createSyncAccessFeature(config: {
	vaultService: VaultService;
	coordinatorNamespace: CoordinatorNamespace;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	accessReader?: (userId: string, vaultId: string) => Promise<number>;
	accessVerifier?: (claims: SyncTokenClaims, token: string) => Promise<unknown>;
}): SyncAccessFeature {
	const tokenFeature = createSyncTokenFeature({ syncTokenSecret: config.syncTokenSecret, accessVerifier: config.accessVerifier });
	const pauseReader = new CoordinatorSyncPauseReader(config.coordinatorNamespace);
	return {
		...tokenFeature,
		tokenIssuer: new IssueSyncTokenService(
			config.vaultService,
			tokenFeature.codec,
			pauseReader,
			config.syncTokenTtlSeconds,
			config.accessReader,
		),
	};
}

export function createSyncTokenFeature(config: {
	syncTokenSecret: string;
	accessVerifier?: (claims: SyncTokenClaims, token: string) => Promise<unknown>;
}): SyncTokenFeature & { codec: JoseSyncTokenCodec } {
	const codec = new JoseSyncTokenCodec(config.syncTokenSecret);
	const tokenVerifier = new VerifySyncTokenService(codec, config.accessVerifier);
	return {
		codec,
		tokenVerifier,
		requestTokenVerifier: createRequestTokenVerifier(tokenVerifier),
		selectSyncWebSocketProtocol,
	};
}
