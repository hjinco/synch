import type { SyncTokenVerifier } from "../ports/outbound";
import type { SocketSession } from "../dto/types";
import type { HealthService } from "./health-service";

export interface VaultInitializer {
	ensureVaultState(vaultId: string): Promise<void>;
}

export class SocketConnectionService {
	constructor(
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly vaultInitializer: VaultInitializer,
		private readonly healthService: Pick<HealthService, "scheduleSummaryFlush">,
	) {}

	/**
	 * Completes an accepted socket while it is registered with the gateway.
	 * Both the Durable Object and Node upgrade paths must call this so the
	 * health summary observes the new connection.
	 */
	async completeSocketOpen(): Promise<void> {
		await this.healthService.scheduleSummaryFlush();
	}

	/**
	 * The verify-token / ensure-vault-state work that must happen before a
	 * socket is accepted, split out from the accept step itself so a runtime
	 * that can't smuggle a WebSocket through a `Response` (i.e. anything but
	 * a Durable Object) can run this, do its own raw upgrade, then call
	 * `completeSocketOpen()`.
	 */
	async prepareSocketSession(
		token: string | null | undefined,
		vaultId: string,
	): Promise<SocketSession> {
		const claims = await this.syncTokenService.verifySyncToken(token, vaultId);
		await this.vaultInitializer.ensureVaultState(claims.vaultId);
		const session = {
			userId: claims.sub,
			localVaultId: claims.localVaultId,
			vaultId: claims.vaultId,
			displayName: claims.displayName,
			wantsStorageStatus: false,
			wantsPresence: false,
			presenceEntryId: null,
			presenceWatchEntryIds: [],
		};
		return session;
	}
}
