import { vi } from "vitest";

import { BlobSyncService } from "../../blob/sync-service";
import { EntryHistoryService } from "../../entry/history-service";
import { EntrySyncService } from "../../entry/sync-service";
import { HealthSyncService } from "../../health/sync-service";
import { CoordinatorMaintenanceService } from "../../maintenance-service";
import type {
	MaintenanceRunner,
	MaintenanceScheduler,
} from "../../maintenance-scheduler";
import { MutationCommitService } from "../../mutation/commit-service";
import type {
	BlobObjectRepository,
	BlobStateStore,
	CoordinatorStorageLifecycle,
	EntryHistoryStore,
	EntryStateStore,
	HealthStateStore,
	InitialVaultLimitReader,
	SocketGateway,
	SyncTokenVerifier,
	VaultStateStore,
} from "../../ports";
import { CoordinatorService } from "../../service";
import { CoordinatorControlMessageHandler } from "../../socket/control-message-handler";
import { CoordinatorSocketConnectionService } from "../../socket/connection-service";
import { VaultLifecycleService } from "../../vault/lifecycle-service";
import type { SocketSession } from "../../types";

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
		purgeDeletedEntryVersions: vi.fn(() => ({ results: [], candidateBlobIds: [] })),
		commitMutations: vi.fn(async (_session, message) => ({
			message: {
				type: "commit_mutations_committed" as const,
				requestId: message.requestId,
				cursor: 0,
				results: [],
			},
			broadcastCursor: null,
		})),
		stageBlob: vi.fn(async () => ({ status: "staged" as const })),
		readBlob: vi.fn(() => null),
		deleteBlobRecord: vi.fn(),
		abortStagedBlob: vi.fn(),
		isBlobPinned: vi.fn(() => false),
		listBlobsReadyForDeletion: vi.fn(() => []),
		deleteBlobIfCollectible: vi.fn(),
		markBlobPendingDeleteIfUnpinned: vi.fn(),
		nextBlobGcAt: vi.fn(() => null),
		recordGcCompleted: vi.fn(),
		readHealthSummary: vi.fn(() => null),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100_000_000,
		})),
		...overrides,
	};
}

export function createMockCoordinatorSocketService(
	overrides: Partial<SocketGateway> = {},
): SocketGateway {
	return {
		openSocket: vi.fn(async () => new Response(null, { status: 200 })),
		readSocketSession: vi.fn(() => null),
		attachSocketSession: vi.fn(),
		sendSocketMessage: vi.fn(() => true),
		broadcastStorageStatus: vi.fn(),
		broadcastPolicyUpdated: vi.fn(),
		broadcastExcept: vi.fn(),
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
		initialVaultLimitReader ?? {
			readInitialVaultLimits: async () => {
				throw new Error("initial vault limit reader is not configured");
			},
		},
		healthSyncService,
	);
	const socketConnectionService = new CoordinatorSocketConnectionService(
		socketService,
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
	coordinatorService = new CoordinatorService({
		blobSyncService,
		entryHistoryService,
		entrySyncService,
		healthSyncService,
		maintenanceService,
		mutationCommitService,
		socketConnectionService,
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
		handleSocketMessage: async (ws: WebSocket, message: string | ArrayBuffer) =>
			await socketMessageHandler.handle(ws, message),
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
	import("../../ports").MutationStore &
	BlobStateStore &
	HealthStateStore;

function createSyncTokenVerifier(): SyncTokenVerifier {
	return {
		requireSyncToken: vi.fn(async (_request, vaultId = "vault-1") => ({
			sub: "user-1",
			vaultId,
			localVaultId: "local-vault-1",
			scope: "vault:sync" as const,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		})),
	};
}

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
		stageBlob: vi.fn(async () => ({ status: "staged" as const })),
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
