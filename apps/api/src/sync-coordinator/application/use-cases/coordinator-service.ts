import type {
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	DeletedEntriesListedMessage,
	DeletedEntriesPurgeResult,
	EntryStatesListedMessage,
	EntryVersionsListedMessage,
	ListDeletedEntriesMessage,
	ListEntryStatesMessage,
	ListEntryVersionsMessage,
	PurgeDeletedEntriesMessage,
	RestoreEntryVersionMessage,
	RestoreEntryVersionResult,
	RestoreEntryVersionsMessage,
	RestoreEntryVersionsResult,
	SocketSession,
	VaultStateLimits,
} from "../dto/types";
import type { SyncPauseState, SyncRepairResult } from "../ports/outbound";

type MutationOptions = { forcedHistoryBefore?: "before_restore" | null };
type GcOptions = {
	now?: number;
	scheduleHealthFlush?: boolean;
	scheduleNextGc?: boolean;
};
type HealthFlushOptions = {
	now?: number;
	throwOnError?: boolean;
};

export interface BlobUseCases {
	stageBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void>;
	abortStagedBlob(token: string | null | undefined, vaultId: string, blobId: string): Promise<void>;
	deleteBlob(token: string | null | undefined, vaultId: string, blobId: string): Promise<void>;
	runGc(vaultId?: string, options?: GcOptions): Promise<number | null>;
}

export interface EntryHistoryUseCases {
	listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage>;
	listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage>;
	restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult>;
	restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult>;
	purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult>;
}

export interface EntrySyncUseCases {
	listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): EntryStatesListedMessage;
}

export interface HealthUseCases {
	scheduleSummaryFlush(now?: number): Promise<void>;
	flushSummary(options?: HealthFlushOptions): Promise<number | null>;
}

export interface MaintenanceUseCases {
	handleAlarm(): Promise<void>;
}

export interface MutationUseCases {
	commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		options?: MutationOptions,
	): Promise<CommitMutationsResult>;
	commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
		options?: MutationOptions,
	): Promise<CommitMutationResult>;
}

export interface SocketConnectionUseCases {
	prepareSocketSession(
		token: string | null | undefined,
		vaultId: string,
	): Promise<SocketSession>;
	completeSocketOpen(): Promise<void>;
}

export interface VaultLifecycleUseCases {
	isPurged(): boolean;
	readSyncPause(vaultId: string): SyncPauseState | null;
	detachLocalVault(session: SocketSession): Promise<void>;
	applyVaultPolicy(
		vaultId: string,
		limits: VaultStateLimits,
	): Promise<{ applied: boolean }>;
	purgeVault(vaultId: string): Promise<void>;
}

export interface SyncRepairUseCases {
	repairSyncState(vaultId: string): Promise<SyncRepairResult>;
}

export type CoordinatorServiceDependencies = {
	blobSyncService: BlobUseCases;
	entryHistoryService: EntryHistoryUseCases;
	entrySyncService: EntrySyncUseCases;
	healthSyncService: HealthUseCases;
	maintenanceService: MaintenanceUseCases;
	mutationCommitService: MutationUseCases;
	socketConnectionService: SocketConnectionUseCases;
	syncRepairService: SyncRepairUseCases;
	vaultLifecycleService: VaultLifecycleUseCases;
};

/** Stable application API shared by the Durable Object, HTTP and WebSocket adapters. */
export class CoordinatorService {
	constructor(private readonly services: CoordinatorServiceDependencies) {}

	async prepareSocketSession(
		token: string | null | undefined,
		vaultId: string,
	): Promise<SocketSession> {
		return await this.services.socketConnectionService.prepareSocketSession(token, vaultId);
	}

	async completeSocketOpen(): Promise<void> {
		await this.services.socketConnectionService.completeSocketOpen();
	}

	readSyncPause(vaultId: string): SyncPauseState | null {
		return this.services.vaultLifecycleService.readSyncPause(vaultId);
	}

	async repairSyncState(vaultId: string): Promise<SyncRepairResult> {
		return await this.services.syncRepairService.repairSyncState(vaultId);
	}

	listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): EntryStatesListedMessage {
		return this.services.entrySyncService.listEntryStates(session, message);
	}

	async detachLocalVault(session: SocketSession): Promise<void> {
		await this.services.vaultLifecycleService.detachLocalVault(session);
	}

	async listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage> {
		return await this.services.entryHistoryService.listEntryVersions(session, message);
	}

	async listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage> {
		return await this.services.entryHistoryService.listDeletedEntries(session, message);
	}

	async restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult> {
		return await this.services.entryHistoryService.restoreEntryVersion(session, message);
	}

	async restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult> {
		return await this.services.entryHistoryService.restoreEntryVersions(session, message);
	}

	async purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult> {
		return await this.services.entryHistoryService.purgeDeletedEntries(session, message);
	}

	async stageBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void> {
		await this.services.blobSyncService.stageBlob(token, vaultId, blobId, sizeBytes);
	}

	async abortStagedBlob(token: string | null | undefined, vaultId: string, blobId: string): Promise<void> {
		await this.services.blobSyncService.abortStagedBlob(token, vaultId, blobId);
	}

	async deleteBlob(token: string | null | undefined, vaultId: string, blobId: string): Promise<void> {
		await this.services.blobSyncService.deleteBlob(token, vaultId, blobId);
	}

	async applyVaultPolicy(
		vaultId: string,
		limits: VaultStateLimits,
	): Promise<{ applied: boolean }> {
		return await this.services.vaultLifecycleService.applyVaultPolicy(vaultId, limits);
	}

	async purgeVault(vaultId: string): Promise<void> {
		await this.services.vaultLifecycleService.purgeVault(vaultId);
	}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		options: MutationOptions = {},
	): Promise<CommitMutationsResult> {
		return await this.services.mutationCommitService.commitMutations(
			session,
			message,
			options,
		);
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
		options: MutationOptions = {},
	): Promise<CommitMutationResult> {
		return await this.services.mutationCommitService.commitMutation(
			session,
			message,
			options,
		);
	}

	async runGc(
		vaultId?: string,
		options: GcOptions = {},
	): Promise<number | null> {
		return await this.services.blobSyncService.runGc(vaultId, options);
	}

	async handleAlarm(): Promise<void> {
		await this.services.maintenanceService.handleAlarm();
	}

	async handleSocketClose(): Promise<void> {
		if (!this.services.vaultLifecycleService.isPurged()) {
			await this.services.healthSyncService.scheduleSummaryFlush();
		}
	}

	async flushHealthSummary(
		options: HealthFlushOptions = {},
	): Promise<void> {
		await this.services.healthSyncService.flushSummary(options);
	}
}
