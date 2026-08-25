import type {
	BlobObjectRepository,
	BlobObjectKeyBuilder,
	CoordinatorStorageLifecycle,
	HealthStateStore,
	InitialVaultLimitReader,
	SocketGateway,
	StaleStagedBlobStore,
	VaultStateStore,
} from "../ports/outbound";
import type { SyncPauseState, SyncRepairResult } from "../dto/sync-repair";
import type { SocketSession, VaultStateLimits } from "../dto/types";
import { isBlobPinned } from "../../domain/blob-gc-policy";
import { STAGED_BLOB_STALE_MS } from "../../domain/health-policy";
import type { BlobGcService } from "./blob-gc-service";
import type { HealthService } from "./health-service";

export const MAX_REPAIRABLE_STALE_STAGED_BLOBS = 100;
const STALE_BLOB_PAUSE_REASON_PREFIX = "staged blob ";

export class VaultService {
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
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly initialVaultLimitReader: InitialVaultLimitReader,
		private readonly healthService: Pick<HealthService, "scheduleSummaryFlush">,
		private readonly staleStagedBlobStore: StaleStagedBlobStore,
		private readonly blobGcService: Pick<BlobGcService, "readNextGcAt" | "scheduleNow">,
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
		await this.healthService.scheduleSummaryFlush();
	}

	async applyVaultPolicy(
		vaultId: string,
		limits: VaultStateLimits,
	): Promise<{ applied: boolean }> {
		const applied = this.vaultStateStore.applyVaultPolicy(vaultId, limits);
		if (applied) {
			await this.healthService.scheduleSummaryFlush();
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
		await this.blobRepository.deleteByPrefix(this.objectKeyBuilder.blobObjectKeyPrefix(vaultId));
		await this.storage.purgeVaultState();
	}

	async repairSyncState(vaultId: string): Promise<SyncRepairResult> {
		if (!this.vaultStateStore.vaultStateExistsFor(vaultId)) {
			return emptyRepairResult(null, null, "not_paused");
		}

		const now = Date.now();
		const pause = this.vaultStateStore.readSyncPause();
		const staleBlobs = this.staleStagedBlobStore.listStaleStagedBlobs(
			now,
			STAGED_BLOB_STALE_MS,
			MAX_REPAIRABLE_STALE_STAGED_BLOBS + 1,
		);

		if (pause && !pause.reason.startsWith(STALE_BLOB_PAUSE_REASON_PREFIX)) {
			return repairRequiredResult(
				pause,
				staleBlobs.length,
				null,
				"unsupported_pause_reason",
			);
		}

		if (staleBlobs.length > MAX_REPAIRABLE_STALE_STAGED_BLOBS) {
			return repairRequiredResult(
				pause,
				staleBlobs.length,
				null,
				"repair_limit_exceeded",
			);
		}

		let deletedStagedBlobCount = 0;
		let issue: SyncRepairResult["issue"];
		for (const blob of staleBlobs) {
			// Drop the staged row first so a concurrent commit cannot mark the
			// blob live after its object has already been deleted. A leftover
			// object is recoverable; a live entry pointing at missing ciphertext
			// is not.
			const metadataResult = this.staleStagedBlobStore.withStagedBlobTransaction(
				blob.blob_id,
				now,
				(transaction) => {
					const facts = transaction.readFacts();
					if (!facts.blob) {
						return "missing";
					}
					if (
						facts.blob.state !== "staged" ||
						isBlobPinned(facts.referenceFacts, false)
					) {
						return "referenced";
					}

					transaction.deleteStagedBlob();
					return "deleted";
				},
			);
			if (metadataResult === "referenced") {
				issue = "referenced_staged_blob";
				continue;
			}

			try {
				await this.blobRepository.delete(
					this.objectKeyBuilder.blobObjectKey(vaultId, blob.blob_id),
				);
			} catch (error) {
				console.error("[sync-repair] blob object deletion failed", {
					vaultId,
					blobId: blob.blob_id,
					error: error instanceof Error ? error.message : String(error),
				});
				issue = "blob_storage_delete_failed";
				continue;
			}

			if (metadataResult === "deleted") {
				deletedStagedBlobCount += 1;
			}
		}

		const remainingStaleBlobs = this.staleStagedBlobStore.listStaleStagedBlobs(
			now,
			STAGED_BLOB_STALE_MS,
			MAX_REPAIRABLE_STALE_STAGED_BLOBS + 1,
		);
		const nextGcAt = this.blobGcService.readNextGcAt(now);

		// Re-arm the shared GC job after repair. The scheduler buckets this to
		// the next alarm boundary and the normal GC handler will remove the job
		// or compute the next real deadline.
		await this.blobGcService.scheduleNow(now);

		if (issue || remainingStaleBlobs.length > 0) {
			return repairRequiredResult(
				pause,
				remainingStaleBlobs.length,
				nextGcAt,
				issue ?? "referenced_staged_blob",
				deletedStagedBlobCount,
			);
		}

		if (pause) {
			this.vaultStateStore.clearSyncPause();
		}

		return {
			status: pause || deletedStagedBlobCount > 0 ? "repaired" : "not_paused",
			deletedStagedBlobCount,
			remainingStaleStagedBlobCount: 0,
			nextGcAt,
			pause: null,
		};
	}
}

function emptyRepairResult(
	pause: SyncPauseState | null,
	nextGcAt: number | null,
	status: SyncRepairResult["status"],
): SyncRepairResult {
	return {
		status,
		deletedStagedBlobCount: 0,
		remainingStaleStagedBlobCount: 0,
		nextGcAt,
		pause,
	};
}

function repairRequiredResult(
	pause: SyncPauseState | null,
	remainingStaleStagedBlobCount: number,
	nextGcAt: number | null,
	issue: NonNullable<SyncRepairResult["issue"]>,
	deletedStagedBlobCount = 0,
): SyncRepairResult {
	return {
		status: "manual_repair_required",
		deletedStagedBlobCount,
		remainingStaleStagedBlobCount,
		nextGcAt,
		pause,
		issue,
	};
}
