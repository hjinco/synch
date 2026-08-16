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
} from "./types";
import type { SyncPauseState } from "./ports";

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
		request: Request,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void>;
	abortStagedBlob(request: Request, vaultId: string, blobId: string): Promise<void>;
	deleteBlob(request: Request, vaultId: string, blobId: string): Promise<void>;
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
	openSocket(request: Request, vaultId: string): Promise<Response>;
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

export type CoordinatorServiceDependencies = {
	blobSyncService: BlobUseCases;
	entryHistoryService: EntryHistoryUseCases;
	entrySyncService: EntrySyncUseCases;
	healthSyncService: HealthUseCases;
	maintenanceService: MaintenanceUseCases;
	mutationCommitService: MutationUseCases;
	socketConnectionService: SocketConnectionUseCases;
	vaultLifecycleService: VaultLifecycleUseCases;
};

/** Stable application API shared by the Durable Object, HTTP and WebSocket adapters. */
export class CoordinatorService {
	constructor(private readonly services: CoordinatorServiceDependencies) {}

	async openSocket(request: Request, vaultId: string): Promise<Response> {
		return await this.services.socketConnectionService.openSocket(request, vaultId);
	}

	readSyncPause(vaultId: string): SyncPauseState | null {
		return this.services.vaultLifecycleService.readSyncPause(vaultId);
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
		request: Request,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void> {
		await this.services.blobSyncService.stageBlob(request, vaultId, blobId, sizeBytes);
	}

	async abortStagedBlob(request: Request, vaultId: string, blobId: string): Promise<void> {
		await this.services.blobSyncService.abortStagedBlob(request, vaultId, blobId);
	}

	async deleteBlob(request: Request, vaultId: string, blobId: string): Promise<void> {
		await this.services.blobSyncService.deleteBlob(request, vaultId, blobId);
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

export type CoordinatorDurableObjectUseCases = Pick<
	CoordinatorService,
	| "commitMutations"
	| "commitMutation"
	| "listEntryStates"
	| "listEntryVersions"
	| "listDeletedEntries"
	| "restoreEntryVersion"
	| "restoreEntryVersions"
	| "purgeDeletedEntries"
	| "runGc"
	| "flushHealthSummary"
	| "handleAlarm"
	| "handleSocketClose"
>;
