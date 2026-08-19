import type { VaultService } from "../../vault/application";
import type { IssueSyncToken, VerifySyncToken } from "../../sync-access/application";
import { CoordinatorSyncPauseReader, type CoordinatorNamespace } from "../../sync-access/adapters/outbound/coordinator-sync-pause-reader";
import { createRequestTokenVerifier, selectSyncWebSocketProtocol } from "../../sync-access/adapters/inbound/http/request-auth";
import { JoseSyncTokenCodec } from "../../sync-access/adapters/outbound/jose-sync-token-codec";
import { IssueSyncTokenUseCase } from "../../sync-access/application/use-cases/issue-sync-token";
import { VerifySyncTokenUseCase } from "../../sync-access/application/use-cases/verify-sync-token";

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
}): SyncAccessFeature {
	const tokenFeature = createSyncTokenFeature({ syncTokenSecret: config.syncTokenSecret });
	const pauseReader = new CoordinatorSyncPauseReader(config.coordinatorNamespace);
	return {
		...tokenFeature,
		tokenIssuer: new IssueSyncTokenUseCase(
			config.vaultService,
			tokenFeature.codec,
			pauseReader,
			config.syncTokenTtlSeconds,
		),
	};
}

export function createSyncTokenFeature(config: {
	syncTokenSecret: string;
}): SyncTokenFeature & { codec: JoseSyncTokenCodec } {
	const codec = new JoseSyncTokenCodec(config.syncTokenSecret);
	const tokenVerifier = new VerifySyncTokenUseCase(codec);
	return {
		codec,
		tokenVerifier,
		requestTokenVerifier: createRequestTokenVerifier(tokenVerifier),
		selectSyncWebSocketProtocol,
	};
}
