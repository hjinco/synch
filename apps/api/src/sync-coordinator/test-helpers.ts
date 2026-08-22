import { vi } from "vitest";

import { SyncCoordinatorApplicationError } from "./application/errors/coordinator-errors";
import { decideBlobStage } from "./domain/blob-policy";
import { STAGED_BLOB_STALE_MS } from "./domain/health-policy";
import type { CoordinatorBlobStore } from "./adapters/outbound/sqlite/blob-store";
import { BlobSyncService } from "./application/use-cases/blob/sync-service";
import { EntryHistoryService } from "./application/use-cases/entry/history-service";
import { EntrySyncService } from "./application/use-cases/entry/sync-service";
import { HealthSyncService } from "./application/use-cases/health/sync-service";
import { CoordinatorMaintenanceService } from "./application/use-cases/maintenance/maintenance-service";
import type {
	MaintenanceRunner,
	MaintenanceScheduler,
} from "./application/ports/outbound";
import { MutationCommitService } from "./application/use-cases/mutation/commit-service";
import type {
	BlobObjectRepository,
	BlobStageTransaction,
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
	SyncTokenVerifier,
	VaultStateStore,
} from "./application/ports/outbound";
import { CoordinatorService } from "./application/use-cases/coordinator-service";
import { CoordinatorSyncRepairService } from "./application/use-cases/repair/repair-service";
import { CoordinatorControlMessageHandler } from "./adapters/inbound/websocket/control-message-handler";
import { CoordinatorSocketConnectionService } from "./application/use-cases/socket/connection-service";
import { VaultLifecycleService } from "./application/use-cases/vault/lifecycle-service";
import type { SocketSession } from "./application/dto/types";
import { parseClientControlMessage } from "./adapters/inbound/websocket/protocol";

export function testSocketSession(
	overrides: Partial<SocketSession> = {},
): SocketSession {
	return {
		userId: "user-1",
		vaultId: "vault-1",
		localVaultId: "local-vault-1",
		wantsStorageStatus: false,
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
			...transaction.readFacts(),
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
		readBlob: vi.fn(() => null),
		listStaleStagedBlobs: vi.fn(() => []),
		deleteBlobRecord: vi.fn(),
		abortStagedBlob: vi.fn(),
		deleteUnreferencedStagedBlob: vi.fn(() => "referenced" as const),
		isBlobPinned: vi.fn(() => false),
		listBlobsReadyForDeletion: vi.fn(() => []),
		deleteBlobIfCollectible: vi.fn(),
		markBlobPendingDeleteIfUnpinned: vi.fn(),
		nextBlobGcAt: vi.fn(() => null),
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
			isPinned: false,
			storageUsedBytes: 0,
			storageLimitBytes: 0,
			maxFileSizeBytes: 0,
		})),
		persistStage: vi.fn(),
		pauseSync: vi.fn(),
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
	const healthSyncService = new HealthSyncService(
		stateRepository,
		null,
		30 * 24 * 60 * 60 * 1000,
		maintenanceScheduler,
	);
	const blobSyncService = new BlobSyncService(
		syncTokenService,
		stateRepository,
		stateRepository,
		stateRepository,
		socketService,
		blobRepository,
		objectKeyBuilder,
		30 * 60 * 1000,
		maintenanceScheduler,
		healthSyncService,
		storageStatusBroadcastDelayMs,
	);
	const mutationCommitService = new MutationCommitService(
		stateRepository,
		stateRepository,
		stateRepository,
		blobRepository,
		objectKeyBuilder,
		30 * 60 * 1000,
		maintenanceScheduler,
		healthSyncService,
	);
	let coordinatorService: CoordinatorService;
	const entrySyncService = new EntrySyncService(stateRepository, stateRepository);
	const entryHistoryService = new EntryHistoryService(
		stateRepository,
		stateRepository,
		stateRepository,
		{
			commitMutation: async (session, message, options) =>
				await coordinatorService.commitMutation(session, message, options),
			commitMutations: async (session, message, options) =>
				await coordinatorService.commitMutations(session, message, options),
		},
		blobSyncService,
	);
	const vaultLifecycleService = new VaultLifecycleService(
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
		healthSyncService,
	);
	const socketConnectionService = new CoordinatorSocketConnectionService(
		syncTokenService,
		vaultLifecycleService,
		healthSyncService,
	);
	const maintenanceService = new CoordinatorMaintenanceService(
		maintenanceScheduler,
		blobSyncService,
		healthSyncService,
		vaultLifecycleService,
	);
	const syncRepairService = new CoordinatorSyncRepairService(
		stateRepository,
		stateRepository,
		blobRepository,
		objectKeyBuilder,
		maintenanceScheduler,
	);
	coordinatorService = new CoordinatorService({
		blobSyncService,
		entryHistoryService,
		entrySyncService,
		healthSyncService,
		maintenanceService,
		mutationCommitService,
		socketConnectionService,
		syncRepairService,
		vaultLifecycleService,
	});
	const socketMessageHandler = new CoordinatorControlMessageHandler(
		socketService,
		stateRepository,
		stateRepository,
		coordinatorService,
		healthSyncService,
	);
	return Object.assign(coordinatorService, {
		dispose: () => blobSyncService.dispose(),
		handleSocketMessage: async (_ws: WebSocket, message: string | ArrayBuffer) => {
			if (typeof message !== "string") return;
			const parsed = parseClientControlMessage(JSON.parse(message));
			if (parsed.success) await socketMessageHandler.handle("test", parsed.data);
		},
	});
}

export type TestCoordinatorService = CoordinatorService & {
	dispose(): void;
	handleSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
};

export type TestCoordinatorState = CoordinatorStorageLifecycle &
	VaultStateStore &
	EntryStateStore &
	EntryHistoryStore &
		import("./application/ports/outbound").MutationStore &
	BlobStateStore &
	HealthStateStore;

function createSyncTokenVerifier(): SyncTokenVerifier {
	return {
		verifySyncToken: vi.fn(async (_token, vaultId = "vault-1") => ({
			sub: "user-1",
			vaultId,
			localVaultId: "local-vault-1",
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
