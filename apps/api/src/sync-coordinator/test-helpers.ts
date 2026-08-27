import { vi } from "vitest";

import { SyncCoordinatorApplicationError } from "./application/errors/coordinator-errors";
import { decideBlobStage } from "./domain/blob-policy";
import { isBlobPinned } from "./domain/blob-gc-policy";
import { STAGED_BLOB_STALE_MS } from "./domain/health-policy";
import type { CoordinatorBlobStore } from "./adapters/outbound/sqlite/blob-store";
import { BlobService } from "./application/services/blob-service";
import { BlobGcService } from "./application/services/blob-gc-service";
import { EntryService } from "./application/services/entry-service";
import { HealthService } from "./application/services/health-service";
import { MaintenanceService } from "./application/services/maintenance-service";
import type {
	MaintenanceRunner,
	MaintenanceScheduler,
} from "./application/ports/outbound";
import { MutationService } from "./application/services/mutation-service";
import type {
	BlobObjectRepository,
	BlobMutationTransaction,
	BlobPendingDeleteTransaction,
	BlobStageTransaction,
	BlobGcStore,
	BlobStateStore,
	CoordinatorStorageLifecycle,
	DeletedEntryPurgeTransaction,
	EntryHistoryStore,
	EntryStateStore,
	HealthStateStore,
	InitialVaultLimitReader,
	MutationStore,
	MutationTransaction,
	SocketGateway,
	StaleStagedBlobStore,
	SyncTokenVerifier,
	VaultStateStore,
} from "./application/ports/outbound";
import {
	bindCoordinatorApi,
	type CoordinatorApi,
} from "./application/services/bind-coordinator-api";
import { CoordinatorControlMessageHandler } from "./adapters/inbound/websocket/control-message-handler";
import { SocketConnectionService } from "./application/services/socket-connection-service";
import { VaultService } from "./application/services/vault-service";
import type { SocketSession } from "./application/dto/types";
import { parseClientControlMessage } from "./adapters/inbound/websocket/protocol";

export function testSocketSession(
	overrides: Partial<SocketSession> = {},
): SocketSession {
	return {
		userId: "user-1",
		vaultId: "vault-1",
		localVaultId: "local-vault-1",
		displayName: "User",
		wantsStorageStatus: false,
		wantsPresence: false,
		presenceEntryId: null,
		presenceWatchEntryIds: [],
		...overrides,
	};
}

export function testWebSocket(): WebSocket {
	return {} as WebSocket;
}

export function stageBlobForTest(
	blobStore: CoordinatorBlobStore,
	blobId: string,
	sizeBytes: number,
	now: number,
	deleteAfter: number,
): { status: "staged" | "sync_paused" } {
	return blobStore.withStageTransaction(blobId, now, (transaction) => {
		const decision = decideBlobStage({
			blobId,
			sizeBytes,
			now,
		staleAfterMs: STAGED_BLOB_STALE_MS,
			...(() => {
				const { referenceFacts, ...facts } = transaction.readFacts();
				return {
					...facts,
					isPinned: facts.existing
						? isBlobPinned(referenceFacts, false)
						: false,
				};
			})(),
		});
		if (decision.kind === "sync_paused") {
			transaction.pauseSync(now, decision.reason);
			return { status: "sync_paused" };
		}
		if (decision.kind === "rejected") {
			throw new SyncCoordinatorApplicationError(decision.code);
		}
		transaction.persistStage({
			sizeBytes,
			now,
			deleteAfter,
			storageDeltaBytes: decision.storageDeltaBytes,
		});
		return { status: "staged" };
	});
}

export function createTestCoordinatorState(
	overrides: Partial<TestCoordinatorState> = {},
): TestCoordinatorState {
	return {
		migrate: vi.fn(async () => {}),
		purgeVaultState: vi.fn(async () => {}),
		currentCursor: vi.fn(() => 0),
		ensureVaultState: vi.fn(),
		readVaultId: vi.fn(() => "vault-1"),
		readSyncPause: vi.fn(() => null),
		clearSyncPause: vi.fn(),
		vaultStateExistsFor: vi.fn(() => true),
		recordLocalVaultConnection: vi.fn(),
		deleteLocalVaultConnection: vi.fn(),
		readVaultLimits: vi.fn(() => ({
			storageLimitBytes: 100_000_000,
			maxFileSizeBytes: 10_000_000,
			versionHistoryRetentionDays: 1,
		})),
		applyVaultPolicy: vi.fn(() => true),
		readVersionHistoryRetentionDays: vi.fn(() => 1),
		listEntryStates: vi.fn(() => []),
		countEntryStates: vi.fn(() => 0),
		listDeletedEntries: vi.fn(() => []),
		readEntry: vi.fn(() => null),
		listEntryVersions: vi.fn(() => []),
		readEntryVersion: vi.fn(() => null),
		withDeletedEntryPurgeTransaction: vi.fn(
			(
				_entryId: string,
				_retentionStart: number,
				operation: (transaction: DeletedEntryPurgeTransaction) => unknown,
			) =>
				operation({
					readFacts: vi.fn(() => ({
						current: null,
						hasRestorableHistory: false,
						candidateBlobIds: [],
					})),
					deleteEntryVersions: vi.fn(),
				}),
		) as EntryHistoryStore["withDeletedEntryPurgeTransaction"],
		withTransaction: vi.fn(runTestMutationTransaction) as MutationStore["withTransaction"],
		withStageTransaction: vi.fn(runTestStageTransaction) as BlobStateStore["withStageTransaction"],
		withBlobTransaction: vi.fn(runTestBlobMutationTransaction) as BlobStateStore["withBlobTransaction"],
		readBlob: vi.fn(() => null),
		readBlobFacts: vi.fn(() => ({
			blob: null,
			referenceFacts: {
				hasCurrentReference: false,
				hasRetainedHistory: false,
				hasActiveStaging: false,
			},
		})),
		listStaleStagedBlobs: vi.fn(() => []),
		deleteBlobRecord: vi.fn(),
		withStagedBlobTransaction: vi.fn(runTestBlobMutationTransaction) as StaleStagedBlobStore["withStagedBlobTransaction"],
		expireEntryVersions: vi.fn(),
		listCollectibleBlobs: vi.fn(() => []),
		readCollectibleBlob: vi.fn(() => null),
		deleteBlobIfCollectible: vi.fn(() => "skipped" as const),
		deleteCollectibleBlobs: vi.fn(() => []),
		withPendingDeleteTransaction: vi.fn(runTestPendingDeleteTransaction) as BlobGcStore["withPendingDeleteTransaction"],
		readGcDeadlines: vi.fn(() => []),
		recordGcCompleted: vi.fn(),
		readHealthSnapshot: vi.fn(() => null),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100_000_000,
		})),
		...overrides,
	};
}

function runTestStageTransaction<T>(
	_blobId: string,
	_now: number,
	operation: (transaction: BlobStageTransaction) => T,
): T {
	return operation({
		readFacts: vi.fn(() => ({
			existing: null,
			referenceFacts: {
				hasCurrentReference: false,
				hasRetainedHistory: false,
				hasActiveStaging: false,
			},
			storageUsedBytes: 0,
			storageLimitBytes: 0,
			maxFileSizeBytes: 0,
		})),
		persistStage: vi.fn(),
		pauseSync: vi.fn(),
	});
}

function runTestBlobMutationTransaction<T>(
	_blobId: string,
	_now: number,
	operation: (transaction: BlobMutationTransaction) => T,
): T {
	return operation({
		readFacts: vi.fn(() => ({
			blob: null,
			referenceFacts: {
				hasCurrentReference: false,
				hasRetainedHistory: false,
				hasActiveStaging: false,
			},
		})),
		deleteStagedBlob: vi.fn(),
	});
}

function runTestPendingDeleteTransaction(
	_blobId: string,
	_now: number,
	operation: (transaction: BlobPendingDeleteTransaction) => void,
): void {
	operation({
		readFacts: vi.fn(() => null),
		markPendingDelete: vi.fn(),
	});
}

function runTestMutationTransaction<T>(
	operation: (transaction: MutationTransaction) => T,
): T {
	let cursor = 0;
	return operation({
		readEntry: vi.fn(() => null),
		readBlobState: vi.fn(() => "staged" as const),
		restagePendingDeleteBlob: vi.fn(),
		insertEntryVersion: vi.fn(() => true),
		readCurrentCursor: vi.fn(() => cursor),
		allocateCursor: vi.fn(() => {
			cursor += 1;
			return cursor;
		}),
		upsertEntry: vi.fn(),
		markBlobLive: vi.fn(),
		markBlobPendingDeleteIfUnreferenced: vi.fn(),
		finalizeCommit: vi.fn(),
	});
}

export function createMockCoordinatorSocketService(
	overrides: Partial<SocketGateway> = {},
): SocketGateway {
	return {
		readSocketSession: vi.fn(() => null),
		attachSocketSession: vi.fn(),
		sendSocketMessage: vi.fn(() => true),
		broadcastStorageStatus: vi.fn(),
		broadcastPolicyUpdated: vi.fn(),
		broadcastPresenceToWatchers: vi.fn(),
		broadcastPresenceAvailability: vi.fn(() => true),
		broadcastExcept: vi.fn(),
		closeSocket: vi.fn(),
		closeAllSockets: vi.fn(),
		...overrides,
	};
}

export function createCoordinatorService({
	syncTokenService = createSyncTokenVerifier(),
	stateRepository = createTestCoordinatorState(),
	socketService = createMockCoordinatorSocketService(),
	blobRepository = createBlobObjectRepository(),
	initialVaultLimitReader = null,
	maintenanceScheduler = createMaintenanceScheduler(),
	storageStatusBroadcastDelayMs = 0,
}: {
	syncTokenService?: SyncTokenVerifier;
	stateRepository?: TestCoordinatorState;
	socketService?: SocketGateway;
	blobRepository?: BlobObjectRepository;
	initialVaultLimitReader?: InitialVaultLimitReader | null;
	maintenanceScheduler?: MaintenanceScheduler & MaintenanceRunner;
	storageStatusBroadcastDelayMs?: number;
} = {}): TestCoordinatorService {
	const healthService = new HealthService(
		stateRepository,
		null,
		30 * 24 * 60 * 60 * 1000,
		maintenanceScheduler,
		socketService,
		storageStatusBroadcastDelayMs,
	);
	const blobGcService = new BlobGcService(
		stateRepository,
		stateRepository,
		blobRepository,
		objectKeyBuilder,
		stateRepository,
		maintenanceScheduler,
		healthService,
	);
	const blobService = new BlobService(
		syncTokenService,
		stateRepository,
		blobGcService,
		socketService,
		blobRepository,
		objectKeyBuilder,
		30 * 60 * 1000,
		healthService,
	);
	const mutationService = new MutationService(
		stateRepository,
		blobGcService,
		stateRepository,
		blobRepository,
		objectKeyBuilder,
		30 * 60 * 1000,
		healthService,
	);
	const entryService = new EntryService(
		stateRepository,
		stateRepository,
		stateRepository,
		mutationService,
		blobGcService,
	);
	const vaultService = new VaultService(
		stateRepository,
		stateRepository,
		stateRepository,
		socketService,
		blobRepository,
		objectKeyBuilder,
		initialVaultLimitReader ?? {
			readInitialVaultLimits: async () => {
				throw new Error("initial vault limit reader is not configured");
			},
		},
		healthService,
		stateRepository,
		blobGcService,
	);
	const socketConnectionService = new SocketConnectionService(
		syncTokenService,
		vaultService,
		healthService,
	);
	const maintenanceService = new MaintenanceService(
		maintenanceScheduler,
		blobGcService,
		healthService,
		vaultService,
	);
	const useCases = bindCoordinatorApi({
		blobService,
		blobGcService,
		entryService,
		healthService,
		maintenanceService,
		mutationService,
		socketConnectionService,
		vaultService,
	});
	const socketMessageHandler = new CoordinatorControlMessageHandler(
		socketService,
		stateRepository,
		stateRepository,
		useCases,
		healthService,
	);
	return Object.assign(useCases, {
		mutationService,
		dispose: () => healthService.dispose(),
		handleSocketMessage: async (
			_ws: WebSocket,
			message: string | ArrayBuffer,
			connectionId = "test",
		) => {
			if (typeof message !== "string") return;
			const parsed = parseClientControlMessage(JSON.parse(message));
			if (parsed.success) await socketMessageHandler.handle(connectionId, parsed.data);
		},
		handleSocketDisconnect: (connectionId = "test") => {
			socketMessageHandler.handleDisconnect(connectionId);
		},
	});
}

export type TestCoordinatorService = CoordinatorApi & {
	mutationService: MutationService;
	dispose(): void;
	handleSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
		connectionId?: string,
	): Promise<void>;
	handleSocketDisconnect(connectionId?: string): void;
};

export type TestCoordinatorState = CoordinatorStorageLifecycle &
	VaultStateStore &
	EntryStateStore &
	EntryHistoryStore &
		import("./application/ports/outbound").MutationStore &
	BlobStateStore &
	BlobGcStore &
	StaleStagedBlobStore &
	HealthStateStore;

function createSyncTokenVerifier(): SyncTokenVerifier {
	return {
		verifySyncToken: vi.fn(async (_token, vaultId = "vault-1") => ({
			sub: "user-1",
			vaultId,
			localVaultId: "local-vault-1",
			displayName: "User",
			scope: "vault:sync" as const,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		})),
	};
}

const objectKeyBuilder = {
	blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
	blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
};

function createBlobObjectRepository(): BlobObjectRepository {
	return {
		exists: vi.fn(async () => true),
		delete: vi.fn(async () => {}),
		deleteMany: vi.fn(async () => ({ failedKeys: [] })),
		deleteByPrefix: vi.fn(async () => {}),
	};
}

function createMaintenanceScheduler(): MaintenanceScheduler & MaintenanceRunner {
	return {
		defer: vi.fn(async () => {}),
		drain: vi.fn(async () => {}),
	};
}

export function socketServiceMock(session = testSocketSession()) {
	return createMockCoordinatorSocketService({
		readSocketSession: vi.fn(() => session),
		attachSocketSession: vi.fn(),
		sendSocketMessage: vi.fn(),
		broadcastStorageStatus: vi.fn(),
		broadcastPolicyUpdated: vi.fn(),
		broadcastPresenceToWatchers: vi.fn(),
		broadcastPresenceAvailability: vi.fn(() => true),
		broadcastExcept: vi.fn(),
		closeAllSockets: vi.fn(),
	});
}

export function socketStateRepository(_session = testSocketSession()) {
	return createTestCoordinatorState({
		vaultStateExistsFor: vi.fn(() => false),
		ensureVaultState: vi.fn(),
		applyVaultPolicy: vi.fn(() => true),
		recordLocalVaultConnection: vi.fn(),
		deleteLocalVaultConnection: vi.fn(),
		currentCursor: vi.fn(() => 11),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 24_300_000,
			storageLimitBytes: 100_000_000,
		})),
		readVaultLimits: vi.fn(() => ({
			storageLimitBytes: 100_000_000,
			maxFileSizeBytes: 10_000_000,
			versionHistoryRetentionDays: 1,
		})),
		readVersionHistoryRetentionDays: vi.fn(() => 1),
	});
}
