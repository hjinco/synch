import type {
	BlobRow,
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	CurrentEntryRow,
	DeletedEntryListRow,
	DeletedEntryPageCursor,
	EntryStatePageCursor,
	EntryStateRow,
	EntryVersionListRow,
	EntryVersionPageCursor,
	EntryVersionReason,
	EntryVersionRow,
	PolicyUpdatedMessage,
	PurgeDeletedEntryBatchResult,
	ServerControlMessage,
	SocketSession,
	StorageStatusSnapshot,
	StorageStatusUpdatedMessage,
	VaultStateLimits,
} from "./types";
import type { VaultSyncStatusSummary } from "../health/types";
import type { SyncTokenClaims } from "../access/token";

export interface SyncTokenVerifier {
	requireSyncToken(
		request: Request,
		expectedVaultId?: string,
	): Promise<SyncTokenClaims>;
}

export interface BlobObjectRepository {
	exists(key: string): Promise<boolean>;
	delete(key: string): Promise<void>;
	deleteByPrefix(prefix: string): Promise<void>;
}

export interface CoordinatorStorageLifecycle {
	migrate(): Promise<void>;
	purgeVaultState(): Promise<void>;
}

export interface InitialVaultLimitReader {
	readInitialVaultLimits(vaultId: string): Promise<VaultStateLimits>;
}

export interface VaultStateStore {
	currentCursor(): number;
	ensureVaultState(vaultId: string, initialLimits: VaultStateLimits): void;
	readVaultId(): string | null;
	readSyncPause(): SyncPauseState | null;
	vaultStateExistsFor(vaultId: string): boolean;
	recordLocalVaultConnection(userId: string, localVaultId: string): void;
	deleteLocalVaultConnection(userId: string, localVaultId: string): void;
	readVaultLimits(): {
		storageLimitBytes: number;
		maxFileSizeBytes: number;
		versionHistoryRetentionDays: number;
	};
	applyVaultPolicy(vaultId: string, limits: VaultStateLimits): boolean;
	readVersionHistoryRetentionDays(): number;
}

export type SyncPauseState = {
	pausedAt: number;
	reason: string;
};

export interface EntryStateStore {
	listEntryStates(
		sinceCursor: number,
		targetCursor: number,
		after: EntryStatePageCursor | null,
		limit: number,
	): EntryStateRow[];
	countEntryStates(sinceCursor: number, targetCursor: number): number;
	listDeletedEntries(
		before: DeletedEntryPageCursor | null,
		retentionStart: number,
		limit: number,
	): DeletedEntryListRow[];
	readEntry(entryId: string): CurrentEntryRow | null;
}

export interface EntryHistoryStore {
	listEntryVersions(
		entryId: string,
		before: EntryVersionPageCursor | null,
		retentionStart: number,
		limit: number,
	): EntryVersionListRow[];
	readEntryVersion(
		entryId: string,
		versionId: string,
		retentionStart: number,
	): EntryVersionRow | null;
	purgeDeletedEntryVersions(
		entries: Array<{ entryId: string; revision: number }>,
		retentionStart: number,
	): {
		results: PurgeDeletedEntryBatchResult[];
		candidateBlobIds: string[];
	};
}

export interface MutationStore {
	commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		stageGracePeriodMs: number,
		versionHistoryRetentionMs: number,
		options?: {
			forcedHistoryBefore?: EntryVersionReason | null;
			unavailableBlobIds?: ReadonlySet<string>;
		},
	): Promise<CommitMutationsResult>;
}

export interface BlobStateStore {
	stageBlob(
		blobId: string,
		sizeBytes: number,
		now: number,
		deleteAfter: number,
	): Promise<StageBlobResult>;
	readBlob(blobId: string): BlobRow | null;
	deleteBlobRecord(blobId: string): void;
	abortStagedBlob(blobId: string, now?: number): void;
	isBlobPinned(blobId: string, includeStaging?: boolean, now?: number): boolean;
	listBlobsReadyForDeletion(now: number, limit: number): BlobRow[];
	deleteBlobIfCollectible(blobId: string, now?: number): void;
	markBlobPendingDeleteIfUnpinned(blobId: string, now?: number): void;
	nextBlobGcAt(): number | null;
}

export type StageBlobResult =
	| { status: "staged" }
	| { status: "sync_paused" };

export interface HealthStateStore {
	recordGcCompleted(now?: number): void;
	readHealthSummary(
		now: number,
		activeCursorTtlMs: number,
	): VaultSyncStatusSummary | null;
	readStorageStatus(): StorageStatusSnapshot;
}

export interface HealthSummaryScheduler {
	scheduleSummaryFlush(now?: number): Promise<void>;
}

export interface MutationCommitter {
	commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
		options?: { forcedHistoryBefore?: "before_restore" | null },
	): Promise<CommitMutationResult>;
	commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		options?: { forcedHistoryBefore?: "before_restore" | null },
	): Promise<CommitMutationsResult>;
}

export interface PurgedBlobCollector {
	collectPurgedBlobs(vaultId: string, blobIds: readonly string[]): Promise<void>;
}

export interface SocketGateway {
	openSocket(
		request: Request,
		session: SocketSession,
	): Promise<Response>;
	readSocketSession(ws: WebSocket): SocketSession | null;
	attachSocketSession(socket: WebSocket, session: SocketSession): void;
	sendSocketMessage(ws: WebSocket, message: ServerControlMessage): boolean;
	broadcastStorageStatus(message: StorageStatusUpdatedMessage): void;
	broadcastPolicyUpdated(message: PolicyUpdatedMessage): void;
	broadcastExcept(excluded: WebSocket, message: ServerControlMessage): void;
	closeAllSockets(code: number, reason: string): void;
}
