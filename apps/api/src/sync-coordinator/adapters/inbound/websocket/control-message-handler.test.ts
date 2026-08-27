import { describe, expect, it, vi } from "vitest";

import {
	createCoordinatorService,
	createMockCoordinatorSocketService,
	createTestCoordinatorState,
	socketServiceMock,
	socketStateRepository,
	testSocketSession,
	testWebSocket,
} from "../../../test-helpers";

describe("coordinator websocket control messages", () => {
	it("uses subscription policy limits when initializing a websocket vault state", async () => {
		const limits = {
			storageLimitBytes: 50_000_000,
			maxFileSizeBytes: 3_000_000,
			versionHistoryRetentionDays: 1,
		};
		const stateRepository = socketStateRepository();
		const socketService = createMockCoordinatorSocketService({
		});
		const initialVaultLimitReader = {
			readInitialVaultLimits: vi.fn(async () => limits),
		};
		const service = createCoordinatorService({
			stateRepository,
			socketService,
			initialVaultLimitReader,
		});

		await service.prepareSocketSession("token", "vault-1");

		expect(initialVaultLimitReader.readInitialVaultLimits).toHaveBeenCalledWith(
			"vault-1",
		);
		expect(stateRepository.ensureVaultState).toHaveBeenCalledWith(
			"vault-1",
			limits,
		);
	});

	it("skips subscription policy lookup when websocket vault state exists", async () => {
		const stateRepository = socketStateRepository();
		vi.mocked(stateRepository.vaultStateExistsFor).mockReturnValue(true);
		const socketService = createMockCoordinatorSocketService({
		});
		const initialVaultLimitReader = {
			readInitialVaultLimits: vi.fn(async () => ({
				storageLimitBytes: 50_000_000,
				maxFileSizeBytes: 3_000_000,
				versionHistoryRetentionDays: 1,
			})),
		};
		const service = createCoordinatorService({
			stateRepository,
			socketService,
			initialVaultLimitReader,
		});

		await service.prepareSocketSession("token", "vault-1");

		expect(stateRepository.vaultStateExistsFor).toHaveBeenCalledWith("vault-1");
		expect(initialVaultLimitReader.readInitialVaultLimits).not.toHaveBeenCalled();
		expect(stateRepository.ensureVaultState).not.toHaveBeenCalled();
	});

	it("does not broadcast cursor advancement back to the socket that committed", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({ stateRepository, socketService });
		const commitMutations = vi.spyOn(service, "commitMutations").mockResolvedValue({
			message: {
				type: "commit_mutations_committed",
				requestId: "request-commit",
				cursor: 42,
				results: [
					{
						status: "accepted",
						mutationId: "mutation-1",
						cursor: 42,
						entryId: "entry-1",
						revision: 3,
					},
				],
			},
			broadcastCursor: 42,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "commit_mutations",
				requestId: "request-commit",
				mutations: [
					{
						mutationId: "mutation-1",
						entryId: "entry-1",
						op: "delete",
						baseRevision: 2,
						blobId: null,
						encryptedMetadata: "metadata",
					},
				],
			}),
		);

		expect(commitMutations).toHaveBeenCalledWith(session, {
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 2,
					blobId: null,
					encryptedMetadata: "metadata",
				},
			],
		});
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "commit_mutations_committed",
			requestId: "request-commit",
			cursor: 42,
			results: [
				{
					status: "accepted",
					mutationId: "mutation-1",
					cursor: 42,
					entryId: "entry-1",
					revision: 3,
				},
			],
		});
		expect(socketService.broadcastExcept).toHaveBeenCalledWith("test", {
			type: "cursor_advanced",
			cursor: 42,
		});
		expect(socketService.broadcastStorageStatus).not.toHaveBeenCalled();
	});

	it("does not send a commit failure after the commit response when cursor broadcast fails", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({ stateRepository, socketService });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(service, "commitMutations").mockResolvedValue({
			message: {
				type: "commit_mutations_committed",
				requestId: "request-commit",
				cursor: 42,
				results: [
					{
						status: "accepted",
						mutationId: "mutation-1",
						cursor: 42,
						entryId: "entry-1",
						revision: 3,
					},
				],
			},
			broadcastCursor: 42,
		});
		vi.mocked(socketService.broadcastExcept).mockImplementation(() => {
			throw new Error("broadcast failed");
		});

		try {
			await service.handleSocketMessage(
				sender,
				JSON.stringify({
					type: "commit_mutations",
					requestId: "request-commit",
					mutations: [
						{
							mutationId: "mutation-1",
							entryId: "entry-1",
							op: "delete",
							baseRevision: 2,
							blobId: null,
							encryptedMetadata: "metadata",
						},
					],
				}),
			);
		} finally {
			consoleError.mockRestore();
		}

		expect(socketService.sendSocketMessage).toHaveBeenCalledTimes(1);
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "commit_mutations_committed",
			requestId: "request-commit",
			cursor: 42,
			results: [
				{
					status: "accepted",
					mutationId: "mutation-1",
					cursor: 42,
					entryId: "entry-1",
					revision: 3,
				},
			],
		});
		expect(socketService.sendSocketMessage).not.toHaveBeenCalledWith(
			sender,
			expect.objectContaining({
				type: "commit_mutations_failed",
				requestId: "request-commit",
			}),
		);
	});

	it("restores entry history over the websocket control channel and broadcasts the cursor", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({ stateRepository, socketService });
		const restoreEntryVersion = vi.spyOn(service, "restoreEntryVersion").mockResolvedValue({
			message: {
				type: "entry_version_restored",
				requestId: "request-restore",
				entryId: "entry-1",
				restoredFromVersionId: "version-1",
				restoredFromRevision: 1,
				cursor: 42,
				revision: 3,
			},
			broadcastCursor: 42,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "restore_entry_version",
				requestId: "request-restore",
				entryId: "entry-1",
				versionId: "version-1",
				baseRevision: 2,
				op: "upsert",
				blobId: "blob-1",
				encryptedMetadata: "ciphertext",
			}),
		);

		expect(restoreEntryVersion).toHaveBeenCalledWith(session, {
			type: "restore_entry_version",
			requestId: "request-restore",
			entryId: "entry-1",
			versionId: "version-1",
			baseRevision: 2,
			op: "upsert",
			blobId: "blob-1",
			encryptedMetadata: "ciphertext",
		});
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "entry_version_restored",
			requestId: "request-restore",
			entryId: "entry-1",
			restoredFromVersionId: "version-1",
			restoredFromRevision: 1,
			cursor: 42,
			revision: 3,
		});
		expect(socketService.broadcastExcept).toHaveBeenCalledWith("test", {
			type: "cursor_advanced",
			cursor: 42,
		});
		expect(socketService.broadcastStorageStatus).not.toHaveBeenCalled();
	});

	it("includes policy but not storage status in the hello acknowledgement", async () => {
		const sender = testWebSocket();
		const stateRepository = socketStateRepository();
		const socketService = socketServiceMock();
		const service = createCoordinatorService({
			stateRepository,
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "hello",
				requestId: "request-hello",
				lastKnownCursor: 7,
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "hello_ack",
			requestId: "request-hello",
			cursor: 11,
			presenceSupported: true,
			policy: {
				storageLimitBytes: 100_000_000,
				maxFileSizeBytes: 10_000_000,
			},
			storageStatus: {
				storageUsedBytes: 24_300_000,
				storageLimitBytes: 100_000_000,
			},
		});
		expect(stateRepository.recordLocalVaultConnection).toHaveBeenCalledWith(
			"user-1",
			"local-vault-1",
		);
	});

	it("rejects a hello cursor that is ahead of the server cursor", async () => {
		const sender = testWebSocket();
		const stateRepository = socketStateRepository();
		const socketService = socketServiceMock();
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "hello",
				requestId: "request-hello",
				lastKnownCursor: 12,
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "session_error",
			code: "cursor_ahead_of_server",
			message:
				"Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Synch settings.",
		});
		expect(stateRepository.recordLocalVaultConnection).not.toHaveBeenCalled();
	});

	it("acknowledges heartbeat messages", async () => {
		const sender = testWebSocket();
		const stateRepository = socketStateRepository();
		const socketService = socketServiceMock();
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "heartbeat",
				requestId: "request-heartbeat",
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "heartbeat_ack",
			requestId: "request-heartbeat",
		});
	});

	it("detaches the current local vault over the websocket control channel", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "detach_local_vault",
				requestId: "request-detach",
			}),
		);

		expect(stateRepository.deleteLocalVaultConnection).toHaveBeenCalledWith(
			session.userId,
			session.localVaultId,
		);
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "local_vault_detached",
			requestId: "request-detach",
		});
	});

	it("enables storage status updates only after a socket watches them", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "watch_storage_status",
			}),
		);

		expect(socketService.attachSocketSession).toHaveBeenCalledWith("test", {
			...session,
			wantsStorageStatus: true,
		});
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "storage_status_updated",
			storageStatus: {
				storageUsedBytes: 24_300_000,
				storageLimitBytes: 100_000_000,
			},
		});
	});

	it("disables storage status updates when a socket stops watching them", async () => {
		const session = testSocketSession({ wantsStorageStatus: true });
		const sender = testWebSocket();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "unwatch_storage_status",
			}),
		);

		expect(socketService.attachSocketSession).toHaveBeenCalledWith("test", {
			...session,
			wantsStorageStatus: false,
		});
		expect(socketService.sendSocketMessage).not.toHaveBeenCalled();
	});

	it("enables presence updates only after a socket watches them", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(session),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "watch_presence",
				entryIds: ["entry-1", "entry-2"],
			}),
		);

		expect(socketService.attachSocketSession).toHaveBeenCalledWith("test", {
			...session,
			presenceWatchEntryIds: ["entry-1", "entry-2"],
			wantsPresence: true,
		});
	});

	it("replays only matching presence payloads after a watcher publishes its entry", async () => {
		const session = testSocketSession({ wantsPresence: true });
		const sender = testWebSocket();
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(session),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(1, 2),
			}),
			"peer",
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "watch_presence",
				entryIds: ["entry-1"],
			}),
			"watcher",
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-2",
				selection: presenceSelection(3, 4),
			}),
			"other",
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(5, 6),
			}),
			"watcher",
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("watcher", {
			type: "presence_updated",
			presenceId: "peer",
			entryId: "entry-1",
			userId: "user-1",
			displayName: "User",
			selection: presenceSelection(1, 2),
		});
		expect(socketService.sendSocketMessage).not.toHaveBeenCalledWith("watcher", {
			type: "presence_updated",
			presenceId: "other",
			entryId: "entry-2",
			userId: "user-1",
			displayName: "User",
			selection: presenceSelection(3, 4),
		});
	});

	it("replays existing payloads for every newly watched entry", async () => {
		const sender = testWebSocket();
		const sessions = {
			peer: testSocketSession({
				userId: "ada",
				localVaultId: "phone",
				wantsPresence: true,
			}),
			watcher: testSocketSession({
				userId: "bob",
				localVaultId: "laptop",
				wantsPresence: true,
			}),
		};
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(
				(connectionId: string) => sessions[connectionId as keyof typeof sessions] ?? null,
			),
		});
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-2",
				selection: presenceSelection(1, 2),
			}),
			"peer",
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "watch_presence",
				entryIds: ["entry-1", "entry-2"],
			}),
			"watcher",
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("watcher", {
			type: "presence_updated",
			presenceId: "peer",
			entryId: "entry-2",
			userId: "ada",
			displayName: "User",
			selection: presenceSelection(1, 2),
		});
	});

	it("stamps presence updates with the sender socket session identity", async () => {
		const sender = testWebSocket();
		const sessions: Record<string, ReturnType<typeof testSocketSession>> = {
			peer: testSocketSession({
				userId: "ada",
				localVaultId: "phone",
				displayName: "Ada",
				wantsPresence: true,
			}),
			watcher: testSocketSession({
				userId: "bob",
				localVaultId: "laptop",
				wantsPresence: true,
			}),
		};
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn((connectionId: string) => sessions[connectionId] ?? null),
		});
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(1, 2),
			}),
			"peer",
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "watch_presence",
				entryIds: ["entry-1"],
			}),
			"watcher",
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(3, 4),
			}),
			"watcher",
		);

		expect(socketService.broadcastPresenceToWatchers).toHaveBeenCalledWith("entry-1", "peer", {
			type: "presence_updated",
			presenceId: "peer",
			entryId: "entry-1",
			userId: "ada",
			displayName: "Ada",
			selection: presenceSelection(1, 2),
		});
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("watcher", {
			type: "presence_updated",
			presenceId: "peer",
			entryId: "entry-1",
			userId: "ada",
			displayName: "Ada",
			selection: presenceSelection(1, 2),
		});
	});

	it("broadcasts presence updates only to watchers", async () => {
		const session = testSocketSession({ wantsPresence: true });
		const sender = testWebSocket();
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(session),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(1, 2),
			}),
		);

		expect(socketService.broadcastPresenceToWatchers).toHaveBeenCalledWith("entry-1", "test", {
			type: "presence_updated",
			presenceId: "test",
			entryId: "entry-1",
			userId: "user-1",
			displayName: "User",
			selection: presenceSelection(1, 2),
		});
	});

	it("broadcasts a clear when a client clears its presence", async () => {
		const session = testSocketSession({ wantsPresence: true });
		const sender = testWebSocket();
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(session),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(1, 2),
			}),
		);
		await service.handleSocketMessage(
			sender,
			JSON.stringify({ type: "presence_clear" }),
		);

		expect(socketService.broadcastPresenceToWatchers).toHaveBeenCalledWith(
			"entry-1",
			"test",
			{
				type: "presence_cleared",
				presenceId: "test",
			},
		);
	});

	it("clears presence when a socket disconnects after publishing", async () => {
		const session = testSocketSession({ wantsPresence: true });
		const sender = testWebSocket();
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(session),
			socketService,
		});

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "presence_update",
				entryId: "entry-1",
				selection: presenceSelection(1, 2),
			}),
		);
		service.handleSocketDisconnect();

		expect(socketService.broadcastPresenceToWatchers).toHaveBeenCalledWith("entry-1", "test", {
			type: "presence_cleared",
			presenceId: "test",
		});
	});

	it("does not broadcast a presence clear when the socket never published", () => {
		const session = testSocketSession();
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository: socketStateRepository(session),
			socketService,
		});

		service.handleSocketDisconnect();

		expect(socketService.broadcastPresenceToWatchers).not.toHaveBeenCalled();
	});

	it("broadcasts storage status after staging a blob", async () => {
		const session = testSocketSession();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository,
			socketService,
			syncTokenService: {
				verifySyncToken: vi.fn(async () => ({
					sub: session.userId,
					vaultId: session.vaultId,
					localVaultId: session.localVaultId,
					aud: "synch-sync",
					iss: "synch",
					exp: 1,
					iat: 1,
			})),
			} as never,
		});

		await service.stageBlob("token", session.vaultId, "blob-1", 100);

		expect(socketService.broadcastStorageStatus).toHaveBeenCalledWith({
			type: "storage_status_updated",
			storageStatus: {
				storageUsedBytes: 24_300_000,
				storageLimitBytes: 100_000_000,
			},
		});
	});

	it("stages blobs without subscription policy limits", async () => {
		const session = testSocketSession();
		const stateRepository = socketStateRepository(session);
		const socketService = socketServiceMock(session);
		const service = createCoordinatorService({
			stateRepository,
			socketService,
			syncTokenService: {
				verifySyncToken: vi.fn(async () => ({
					sub: session.userId,
					vaultId: session.vaultId,
					localVaultId: session.localVaultId,
					aud: "synch-sync",
					iss: "synch",
					exp: 1,
					iat: 1,
				})),
			} as never,
		});

		await service.stageBlob(
			"token",
			session.vaultId,
			"blob-unlimited",
			50_000_000,
		);

		expect(stateRepository.withStageTransaction).toHaveBeenCalledWith(
				"blob-unlimited",
				expect.any(Number),
				expect.any(Function),
			);
		expect(socketService.broadcastStorageStatus).toHaveBeenCalledWith({
			type: "storage_status_updated",
			storageStatus: {
				storageUsedBytes: 24_300_000,
				storageLimitBytes: 100_000_000,
			},
		});
	});

	it("applies refreshed vault policy limits to the coordinator state", async () => {
		const stateRepository = socketStateRepository();
		const socketService = socketServiceMock();
		const service = createCoordinatorService({
			stateRepository,
			socketService,
		});

		await service.applyVaultPolicy(
			"vault-1",
			{
				storageLimitBytes: 50_000_000,
				maxFileSizeBytes: 3_000_000,
				versionHistoryRetentionDays: 1,
			},
		);

		const limits = {
			storageLimitBytes: 50_000_000,
			maxFileSizeBytes: 3_000_000,
			versionHistoryRetentionDays: 1,
		};
		expect(stateRepository.ensureVaultState).not.toHaveBeenCalled();
		expect(stateRepository.applyVaultPolicy).toHaveBeenCalledWith("vault-1", limits);
		expect(socketService.broadcastPolicyUpdated).toHaveBeenCalledWith({
			type: "policy_updated",
			policy: {
				storageLimitBytes: 50_000_000,
				maxFileSizeBytes: 3_000_000,
			},
			storageStatus: {
				storageUsedBytes: 24_300_000,
				storageLimitBytes: 100_000_000,
			},
		});
	});

	it("broadcasts storage status after blob GC deletes candidates", async () => {
		const stateRepository = socketStateRepository();
		const socketService = socketServiceMock();
		const blobRepository = {
			deleteMany: vi.fn(async () => ({ failedKeys: [] })),
		};
		const candidate = {
			blob_id: "blob-1",
			state: "pending_delete" as const,
			size_bytes: 100,
			created_at: 1,
			last_uploaded_at: 1,
			delete_after: 2,
		};
		const service = createCoordinatorService({
			stateRepository: {
				...stateRepository,
				readVaultId: vi.fn(() => "vault-1"),
				listCollectibleBlobs: vi.fn(() => [candidate]),
				deleteCollectibleBlobs: vi.fn(() => [candidate]),
				readGcDeadlines: vi.fn(() => []),
				recordGcCompleted: vi.fn(),
			} as never,
			socketService,
			blobRepository: blobRepository as never,
		});

		await service.runGc("vault-1", { scheduleHealthFlush: false });

		expect(blobRepository.deleteMany).toHaveBeenCalledWith(["vault-1/blob-1"]);
		expect(socketService.broadcastStorageStatus).toHaveBeenCalledWith({
			type: "storage_status_updated",
			storageStatus: {
				storageUsedBytes: 24_300_000,
				storageLimitBytes: 100_000_000,
			},
		});
	});

	it("leaves purged history blobs retryable when immediate R2 deletion fails", async () => {
		const stateRepository = socketStateRepository();
		const blobRepository = {
			deleteMany: vi.fn(async () => {
				throw new Error("r2 unavailable");
			}),
		};
		const withDeletedEntryPurgeTransaction = vi.fn(
			(_entryId, _retentionStart, operation) =>
				operation({
					readFacts: vi.fn(() => ({
						current: { revision: 2, deleted: true },
						hasRestorableHistory: true,
						candidateBlobIds: ["blob-1"],
					})),
					deleteEntryVersions: vi.fn(),
				}),
		);
		const withPendingDeleteTransaction = vi.fn((_blobId, _now, operation) =>
			operation({
				readFacts: vi.fn(() => ({
					state: "pending_delete" as const,
					deleteAfter: 1,
					hasCurrentReference: false,
					hasRetainedHistory: false,
				})),
				markPendingDelete: vi.fn(),
			}),
		);
		const deleteCollectibleBlobs = vi.fn();
		const candidate = {
			blob_id: "blob-1",
			state: "pending_delete" as const,
			size_bytes: 100,
			created_at: 1,
			last_uploaded_at: 1,
			delete_after: 1,
		};
		const service = createCoordinatorService({
			stateRepository: {
				...stateRepository,
				withDeletedEntryPurgeTransaction,
				withPendingDeleteTransaction,
				readCollectibleBlob: vi.fn(() => candidate),
				deleteCollectibleBlobs,
				readGcDeadlines: vi.fn(() => [1]),
			} as never,
			socketService: socketServiceMock(),
			blobRepository: blobRepository as never,
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			service.purgeDeletedEntries(testSocketSession(), {
				type: "purge_deleted_entries",
				requestId: "request-purge",
				entries: [{ entryId: "entry-1", revision: 2 }],
			}),
		).resolves.toEqual({
			message: {
				type: "deleted_entries_purged",
				requestId: "request-purge",
				results: [
					{
						status: "accepted",
						entryId: "entry-1",
					},
				],
			},
			candidateBlobIds: ["blob-1"],
		});

		expect(withDeletedEntryPurgeTransaction).toHaveBeenCalled();
		expect(withPendingDeleteTransaction).toHaveBeenCalledWith(
			"blob-1",
			expect.any(Number),
			expect.any(Function),
		);
		expect(blobRepository.deleteMany).toHaveBeenCalledWith(["vault-1/blob-1"]);
		expect(deleteCollectibleBlobs).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("ignores socket close bookkeeping after a vault purge deletes storage", async () => {
		let service: ReturnType<typeof createCoordinatorService>;
		const stateRepository = createTestCoordinatorState({
			purgeVaultState: vi.fn(async () => {}),
		});
		const socketService = socketServiceMock();
		vi.mocked(socketService.closeAllSockets).mockImplementation(() => {
			void service.handleSocketClose();
		});
		const blobRepository = {
			deleteByPrefix: vi.fn(async () => {}),
		};
		service = createCoordinatorService({
			stateRepository,
			socketService,
			blobRepository: blobRepository as never,
		});

		await service.purgeVault("vault-1");
		await service.handleSocketClose();

		expect(socketService.closeAllSockets).toHaveBeenCalledWith(4403, "vault deleted");
		expect(blobRepository.deleteByPrefix).toHaveBeenCalledWith("vault-1/");
		expect(stateRepository.purgeVaultState).toHaveBeenCalled();
	});

	it("ignores maintenance alarms after a vault purge deletes storage", async () => {
		const stateRepository = createTestCoordinatorState({
			purgeVaultState: vi.fn(async () => {}),
		});
		const socketService = socketServiceMock();
		const blobRepository = {
			deleteByPrefix: vi.fn(async () => {}),
		};
		const maintenanceScheduler = {
			defer: vi.fn(async () => {}),
			drain: vi.fn(async () => {}),
		};
		const service = createCoordinatorService({
			stateRepository,
			socketService,
			blobRepository: blobRepository as never,
			maintenanceScheduler,
		});

		await service.purgeVault("vault-1");
		await service.handleAlarm();

		expect(maintenanceScheduler.drain).not.toHaveBeenCalled();
	});
});

function presenceSelection(line: number, ch: number) {
	return {
		anchor: { line, ch },
		head: { line, ch },
	};
}
