import type {
	HealthSummaryScheduler,
	SocketGateway,
	SyncTokenVerifier,
} from "../ports";
import type { SocketSession } from "../types";

export interface VaultInitializer {
	ensureVaultState(vaultId: string): Promise<void>;
}

export class CoordinatorSocketConnectionService {
	constructor(
		private readonly socketGateway: Pick<SocketGateway, "openSocket">,
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly vaultInitializer: VaultInitializer,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
	) {}

	async openSocket(request: Request, vaultId: string): Promise<Response> {
		const session = await this.prepareSocketSession(request, vaultId);
		const response = await this.socketGateway.openSocket(request, session);
		await this.completeSocketOpen();
		return response;
	}

	/**
	 * The verify-token / ensure-vault-state work that must happen before a
	 * socket is accepted, split out from the accept step itself so a runtime
	 * that can't smuggle a WebSocket through a `Response` (i.e. anything but
	 * a Durable Object) can run this, do its own raw upgrade, then call
	 * `completeSocketOpen()`.
	 */
	async prepareSocketSession(request: Request, vaultId: string): Promise<SocketSession> {
		const claims = await this.syncTokenService.requireSyncToken(request, vaultId);
		await this.vaultInitializer.ensureVaultState(claims.vaultId);
		return {
			userId: claims.sub,
			localVaultId: claims.localVaultId,
			vaultId: claims.vaultId,
			wantsStorageStatus: false,
		};
	}

	async completeSocketOpen(): Promise<void> {
		await this.healthSummaryScheduler.scheduleSummaryFlush();
	}
}
