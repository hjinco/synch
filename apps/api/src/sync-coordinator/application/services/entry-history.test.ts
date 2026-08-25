import { describe, expect, it, vi } from "vitest";

import {
	createCoordinatorService,
	createMockCoordinatorSocketService,
	createTestCoordinatorState,
	testSocketSession,
	testWebSocket,
} from "../../test-helpers";

describe("coordinator entry version history", () => {
	it("lists entry history over the websocket control channel", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(() => session),
			sendSocketMessage: vi.fn(),
		});
		const stateRepository = createTestCoordinatorState({
			listEntryVersions: vi.fn(() => [
				{
					version_id: "version-1",
					entry_id: "entry-1",
					source_revision: 2,
					op_type: "upsert" as const,
					blob_id: "blob-1",
					encrypted_metadata: "metadata",
					reason: "auto" as const,
					captured_at: 123,
				},
			]),
		});
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "list_entry_versions",
				requestId: "request-history",
				entryId: "entry-1",
				before: null,
				limit: 100,
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "entry_versions_listed",
			requestId: "request-history",
			entryId: "entry-1",
			versions: [
				{
					versionId: "version-1",
					sourceRevision: 2,
					op: "upsert",
					blobId: "blob-1",
					encryptedMetadata: "metadata",
					reason: "auto",
					capturedAt: 123,
				},
			],
			hasMore: false,
			nextBefore: null,
		});
	});

	it("restores entry history with client-reencrypted metadata", async () => {
		const session = testSocketSession();
		const stateRepository = createTestCoordinatorState({
			readEntry: vi.fn(() => ({
				entry_id: "entry-1",
				revision: 2,
				blob_id: "blob-current",
				encrypted_metadata: "current-metadata",
				deleted: 0,
			})),
			readEntryVersion: vi.fn(() => ({
				version_id: "version-1",
				entry_id: "entry-1",
				source_revision: 1,
				op_type: "upsert" as const,
				blob_id: "blob-1",
				encrypted_metadata: "old-metadata",
				reason: "auto" as const,
				bucket_start_ms: 0,
				captured_at: 123,
				created_by_user_id: "user-2",
				created_by_local_vault_id: "local-vault-2",
			})),
		});
		const service = createCoordinatorService({ stateRepository });
		const commitMutation = vi.spyOn(
			service.mutationService,
			"commitMutation",
		).mockResolvedValue({
			message: {
				type: "commit_accepted",
				requestId: "request-restore",
				cursor: 42,
				entryId: "entry-1",
				revision: 3,
			},
			broadcastCursor: 42,
		});

		await expect(
			service.restoreEntryVersion(session, {
				type: "restore_entry_version",
				requestId: "request-restore",
				entryId: "entry-1",
				versionId: "version-1",
				baseRevision: 2,
				op: "upsert",
				blobId: "blob-1",
				encryptedMetadata: "reencrypted-metadata",
			}),
		).resolves.toEqual({
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

		expect(commitMutation).toHaveBeenCalledWith(
			session,
			{
				type: "commit_mutation",
				requestId: "request-restore",
				mutation: expect.objectContaining({
					entryId: "entry-1",
					op: "upsert",
					baseRevision: 2,
					blobId: "blob-1",
					encryptedMetadata: "reencrypted-metadata",
				}),
			},
			{ forcedHistoryBefore: "before_restore" },
		);
	});

	it("restores entry history in batches with per-entry results", async () => {
		const session = testSocketSession();
		const stateRepository = createTestCoordinatorState({
			readEntry: vi.fn(() => ({
				entry_id: "entry-1",
				revision: 2,
				blob_id: "blob-current",
				encrypted_metadata: "current-metadata",
				deleted: 0,
			})),
			readEntryVersion: vi.fn(() => ({
				version_id: "version-1",
				entry_id: "entry-1",
				source_revision: 1,
				op_type: "upsert" as const,
				blob_id: "blob-1",
				encrypted_metadata: "old-metadata",
				reason: "auto" as const,
				bucket_start_ms: 0,
				captured_at: 123,
				created_by_user_id: "user-2",
				created_by_local_vault_id: "local-vault-2",
			})),
		});
		const service = createCoordinatorService({ stateRepository });
		const commitMutations = vi.spyOn(
			service.mutationService,
			"commitMutations",
		).mockResolvedValue({
			message: {
				type: "commit_mutations_committed",
				requestId: "request-restore-batch",
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

		await expect(
			service.restoreEntryVersions(session, {
				type: "restore_entry_versions",
				requestId: "request-restore-batch",
				restores: [
					{
						entryId: "entry-1",
						versionId: "version-1",
						baseRevision: 2,
						op: "upsert",
						blobId: "blob-1",
						encryptedMetadata: "reencrypted-metadata",
					},
				],
			}),
		).resolves.toEqual({
			message: {
				type: "entry_versions_restored",
				requestId: "request-restore-batch",
				cursor: 42,
				results: [
					{
						status: "accepted",
						entryId: "entry-1",
						restoredFromVersionId: "version-1",
						restoredFromRevision: 1,
						cursor: 42,
						revision: 3,
					},
				],
			},
			broadcastCursor: 42,
		});

		expect(commitMutations).toHaveBeenCalledWith(
			session,
			{
				type: "commit_mutations",
				requestId: "request-restore-batch",
				mutations: [
					expect.objectContaining({
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 2,
						blobId: "blob-1",
						encryptedMetadata: "reencrypted-metadata",
					}),
				],
			},
			{ forcedHistoryBefore: "before_restore" },
		);
	});

	it("rejects stale client-assisted restores", async () => {
		const session = testSocketSession();
		const stateRepository = createTestCoordinatorState({
			readEntry: vi.fn(() => ({
				entry_id: "entry-1",
				revision: 3,
				blob_id: "blob-current",
				encrypted_metadata: "current-metadata",
				deleted: 0,
			})),
			readEntryVersion: vi.fn(() => ({
				version_id: "version-1",
				entry_id: "entry-1",
				source_revision: 1,
				op_type: "upsert" as const,
				blob_id: "blob-1",
				encrypted_metadata: "old-metadata",
				reason: "auto" as const,
				bucket_start_ms: 0,
				captured_at: 123,
				created_by_user_id: "user-2",
				created_by_local_vault_id: "local-vault-2",
			})),
		});
		const service = createCoordinatorService({ stateRepository });

		await expect(
			service.restoreEntryVersion(session, {
				type: "restore_entry_version",
				requestId: "request-restore",
				entryId: "entry-1",
				versionId: "version-1",
				baseRevision: 2,
				op: "upsert",
				blobId: "blob-1",
				encryptedMetadata: "reencrypted-metadata",
			}),
		).rejects.toMatchObject({
			code: "stale_revision",
			details: { expectedBaseRevision: 3, receivedBaseRevision: 2 },
		});
	});

	it("rejects restores when the client payload does not match the version", async () => {
		const session = testSocketSession();
		const stateRepository = createTestCoordinatorState({
			readEntry: vi.fn(() => ({
				entry_id: "entry-1",
				revision: 2,
				blob_id: "blob-current",
				encrypted_metadata: "current-metadata",
				deleted: 0,
			})),
			readEntryVersion: vi.fn(() => ({
				version_id: "version-1",
				entry_id: "entry-1",
				source_revision: 1,
				op_type: "upsert" as const,
				blob_id: "blob-1",
				encrypted_metadata: "old-metadata",
				reason: "auto" as const,
				bucket_start_ms: 0,
				captured_at: 123,
				created_by_user_id: "user-2",
				created_by_local_vault_id: "local-vault-2",
			})),
		});
		const service = createCoordinatorService({ stateRepository });

		await expect(
			service.restoreEntryVersion(session, {
				type: "restore_entry_version",
				requestId: "request-restore",
				entryId: "entry-1",
				versionId: "version-1",
				baseRevision: 2,
				op: "delete",
				blobId: null,
				encryptedMetadata: "reencrypted-metadata",
			}),
		).rejects.toMatchObject({
			code: "version_mismatch",
			details: { message: "restore payload does not match the requested version" },
		});
	});
});
