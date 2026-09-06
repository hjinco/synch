import { vi } from "vitest";

import { SyncCoordinatorApplicationError } from "./application/errors/coordinator-errors";
import { stageBlobRecord } from "./application/services/blob-record-operations";
import type {
	CoordinatorStores,
	CoordinatorUnitOfWork,
	EntryStore,
	EntryVersionStore,
	BlobStore,
	BlobGcQueries,
	CoordinatorStateStore,
	LocalVaultConnectionStore,
} from "./application/ports/outbound";
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
	CoordinatorStorageLifecycle,
	HealthStateStore,
	InitialVaultLimitReader,
	SocketGateway,
	SyncTokenVerifier,
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
	unitOfWork: CoordinatorUnitOfWork<"blobs" | "blobReferences" | "state">,
	blobId: string,
	sizeBytes: number,
	now: number,
	deleteAfter: number,
): { status: "staged" | "sync_paused" } {
	return unitOfWork.run((stores) => {
		const decision = stageBlobRecord(
			stores,
			blobId,
			sizeBytes,
			now,
			deleteAfter,
		);
		if (decision.kind === "rejected")
			throw new SyncCoordinatorApplicationError(decision.code);
		return { status: decision.kind };
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
		readMutationEntry: vi.fn(() => null),
		upsertEntry: vi.fn(),
		insertEntryVersion: vi.fn(() => true),
		hasRestorableHistory: vi.fn(() => false),
		listBlobIds: vi.fn(() => []),
		deleteEntryVersions: vi.fn(),
		readBlob: vi.fn(() => null),
		read: vi.fn(() => ({
			hasCurrentReference: false,
			hasRetainedHistory: false,
		})),
		persistStage: vi.fn(),
		updateState: vi.fn(),
		listStaleStagedBlobs: vi.fn(() => []),
		deleteBlobRecord: vi.fn(() => []),
		expireEntryVersions: vi.fn(),
		listCollectibleBlobs: vi.fn(() => []),
		readCollectibleBlob: vi.fn(() => null),
		deleteCollectibleBlobs: vi.fn(() => []),
		readGcDeadlines: vi.fn(() => []),
		readStorageUsedBytes: vi.fn(() => 0),
		adjustStorageUsedBytes: vi.fn(),
		pauseSync: vi.fn(),
		saveCommit: vi.fn(),
		recordGcCompleted: vi.fn(),
		readHealthSnapshot: vi.fn(() => null),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100_000_000,
		})),
		...overrides,
	};
}

/** Thin transaction callback runner for service interaction tests. Rollback is tested with real SQLite. */
export function createTestUnitOfWork(
	state: TestCoordinatorState,
): CoordinatorUnitOfWork {
	const stores: CoordinatorStores = {
		entries: state,
		versions: state,
		blobs: state,
		gc: state,
		state,
		connections: state,
		blobReferences: state,
	};
	return { stores, run: (operation) => operation(stores) };
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
	const unitOfWork = createTestUnitOfWork(stateRepository);
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
		unitOfWork,
		blobRepository,
		objectKeyBuilder,
		maintenanceScheduler,
		healthService,
	);
	const blobService = new BlobService(
		syncTokenService,
		unitOfWork,
		blobGcService,
		socketService,
		blobRepository,
		objectKeyBuilder,
		30 * 60 * 1000,
		healthService,
	);
	const mutationService = new MutationService(
		unitOfWork,
		blobGcService,
		stateRepository,
		blobRepository,
		objectKeyBuilder,
		30 * 60 * 1000,
		healthService,
	);
	const entryService = new EntryService(
		unitOfWork,
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
		unitOfWork,
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
	const services = bindCoordinatorApi({
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
		services,
		healthService,
		stateRepository,
	);
	return Object.assign(services, {
		mutationService,
		dispose: () => healthService.dispose(),
		handleSocketMessage: async (
			_ws: WebSocket,
			message: string | ArrayBuffer,
			connectionId = "test",
		) => {
			if (typeof message !== "string") return;
			const parsed = parseClientControlMessage(JSON.parse(message));
			if (parsed.success)
				await socketMessageHandler.handle(connectionId, parsed.data);
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
	CoordinatorStateStore &
	EntryStore &
	EntryVersionStore &
	BlobStore &
	BlobGcQueries &
	LocalVaultConnectionStore &
	CoordinatorStores["blobReferences"] &
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

function createMaintenanceScheduler(): MaintenanceScheduler &
	MaintenanceRunner {
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
