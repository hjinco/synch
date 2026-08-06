import { blobObjectKeyPrefix } from "../../blob/object-key";
import type {
	BlobObjectRepository,
	CoordinatorStorageLifecycle,
	HealthStateStore,
	HealthSummaryScheduler,
	InitialVaultLimitReader,
	SocketGateway,
	SyncPauseState,
	VaultStateStore,
} from "../ports";
import type { SocketSession, VaultStateLimits } from "../types";

export class VaultLifecycleService {
	private purged = false;

	constructor(
		private readonly storage: CoordinatorStorageLifecycle,
		private readonly vaultStateStore: VaultStateStore,
		private readonly healthStore: Pick<HealthStateStore, "readStorageStatus">,
		private readonly socketGateway: Pick<
			SocketGateway,
			"broadcastPolicyUpdated" | "closeAllSockets"
		>,
		private readonly blobRepository: BlobObjectRepository,
		private readonly initialVaultLimitReader: InitialVaultLimitReader,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
	) {}

	isPurged(): boolean {
		return this.purged;
	}

	readSyncPause(vaultId: string): SyncPauseState | null {
		if (!this.vaultStateStore.vaultStateExistsFor(vaultId)) {
			return null;
		}
		return this.vaultStateStore.readSyncPause();
	}

	async ensureVaultState(vaultId: string): Promise<void> {
		if (this.vaultStateStore.vaultStateExistsFor(vaultId)) {
			return;
		}

		const initialLimits =
			await this.initialVaultLimitReader.readInitialVaultLimits(vaultId);
		this.vaultStateStore.ensureVaultState(vaultId, initialLimits);
	}

	async detachLocalVault(session: SocketSession): Promise<void> {
		this.vaultStateStore.deleteLocalVaultConnection(
			session.userId,
			session.localVaultId,
		);
		await this.healthSummaryScheduler.scheduleSummaryFlush();
	}

	async applyVaultPolicy(
		vaultId: string,
		limits: VaultStateLimits,
	): Promise<{ applied: boolean }> {
		const applied = this.vaultStateStore.applyVaultPolicy(vaultId, limits);
		if (applied) {
			await this.healthSummaryScheduler.scheduleSummaryFlush();
			this.socketGateway.broadcastPolicyUpdated({
				type: "policy_updated",
				policy: {
					storageLimitBytes: limits.storageLimitBytes,
					maxFileSizeBytes: limits.maxFileSizeBytes,
				},
				storageStatus: this.healthStore.readStorageStatus(),
			});
		}
		return { applied };
	}

	async purgeVault(vaultId: string): Promise<void> {
		this.purged = true;
		this.socketGateway.closeAllSockets(4403, "vault deleted");
		await this.blobRepository.deleteByPrefix(blobObjectKeyPrefix(vaultId));
		await this.storage.purgeVaultState();
	}
}
