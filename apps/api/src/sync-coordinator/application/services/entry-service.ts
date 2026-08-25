import { SyncCoordinatorApplicationError } from "../errors/coordinator-errors";
import {
	decideDeletedEntryPurge,
	isCurrentRevision,
	isRestorePayloadCompatible,
} from "../../domain/entry-policy";
import type {
	CommitMutationsMessage,
	DeletedEntriesPurgeResult,
	DeletedEntriesListedMessage,
	EntryStatesListedMessage,
	EntryVersionsListedMessage,
	ListDeletedEntriesMessage,
	ListEntryStatesMessage,
	ListEntryVersionsMessage,
	PurgeDeletedEntriesMessage,
	PurgeDeletedEntryBatchResult,
	RestoreEntryVersionBatchResult,
	RestoreEntryVersionMessage,
	RestoreEntryVersionResult,
	RestoreEntryVersionsMessage,
	RestoreEntryVersionsResult,
	SocketSession,
} from "../dto/types";
import type {
	EntryHistoryStore,
	EntryStateStore,
	VaultStateStore,
} from "../ports/outbound";
import type { BlobGcService } from "./blob-gc-service";
import type { MutationService } from "./mutation-service";

const MAX_HISTORY_BATCH = 100;
const MAX_DELETED_ENTRIES_BATCH = 100;
const MAX_ENTRY_STATE_BATCH = 500;

export class EntryService {
	constructor(
		private readonly entryStore: EntryStateStore,
		private readonly historyStore: EntryHistoryStore,
		private readonly vaultStateStore: Pick<
			VaultStateStore,
			"currentCursor" | "readVersionHistoryRetentionDays"
		>,
		private readonly mutationService: Pick<
			MutationService,
			"commitMutation" | "commitMutations"
		>,
		private readonly blobGcService: Pick<BlobGcService, "collectPurgedBlobs">,
	) {}

	listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): EntryStatesListedMessage {
		const effectiveLimit = Math.min(message.limit, MAX_ENTRY_STATE_BATCH);
		const currentCursor = this.vaultStateStore.currentCursor();
		const targetCursor =
			message.targetCursor === null
				? currentCursor
				: message.targetCursor;
		validateCursorRange(message, targetCursor, currentCursor);
		const entries = this.entryStore.listEntryStates(
			message.sinceCursor,
			targetCursor,
			message.after,
			effectiveLimit + 1,
		);
		const totalEntries = this.entryStore.countEntryStates(
			message.sinceCursor,
			targetCursor,
		);
		const hasMore = entries.length > effectiveLimit;
		const page = hasMore ? entries.slice(0, effectiveLimit) : entries;
		const last = page.at(-1);

		return {
			type: "entry_states_listed",
			requestId: message.requestId,
			targetCursor,
			totalEntries,
			hasMore,
			nextAfter:
				hasMore && last
					? {
							updatedSeq: last.updated_seq,
							entryId: last.entry_id,
						}
					: null,
			entries: page.map((entry) => ({
				entryId: entry.entry_id,
				revision: entry.revision,
				blobId: entry.blob_id,
				encryptedMetadata: entry.encrypted_metadata,
				deleted: entry.deleted,
				updatedSeq: entry.updated_seq,
				updatedAt: entry.updated_at,
			})),
		};
	}

	async listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage> {
		const versionHistoryRetentionMs = this.readVersionHistoryRetentionMs();
		const retentionStart = Date.now() - versionHistoryRetentionMs;
		const effectiveLimit = Math.min(message.limit, MAX_DELETED_ENTRIES_BATCH);
		const entries = this.entryStore.listDeletedEntries(
			message.before,
			retentionStart,
			effectiveLimit + 1,
		);
		const hasMore = entries.length > effectiveLimit;
		const page = hasMore ? entries.slice(0, effectiveLimit) : entries;
		const last = page.at(-1);

		return {
			type: "deleted_entries_listed",
			requestId: message.requestId,
			entries: page.map((entry) => ({
				entryId: entry.entry_id,
				revision: entry.revision,
				encryptedMetadata: entry.encrypted_metadata,
				deletedAt: entry.deleted_at,
			})),
			hasMore,
			nextBefore:
				hasMore && last
					? {
							deletedAt: last.deleted_at,
							entryId: last.entry_id,
						}
					: null,
		};
	}

	async listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage> {
		const versionHistoryRetentionMs = this.readVersionHistoryRetentionMs();
		const retentionStart = Date.now() - versionHistoryRetentionMs;
		const effectiveLimit = Math.min(message.limit, MAX_HISTORY_BATCH);
		const versions = this.historyStore.listEntryVersions(
			message.entryId,
			message.before,
			retentionStart,
			effectiveLimit + 1,
		);
		const hasMore = versions.length > effectiveLimit;
		const page = hasMore ? versions.slice(0, effectiveLimit) : versions;
		if (page.length === 0 && !this.entryStore.readEntry(message.entryId)) {
			throw new SyncCoordinatorApplicationError("not_found", {
				message: "entry history not found",
			});
		}
		const last = page.at(-1);

		return {
			type: "entry_versions_listed",
			requestId: message.requestId,
			entryId: message.entryId,
			versions: page.map((version) => ({
				versionId: version.version_id,
				sourceRevision: version.source_revision,
				op: version.op_type,
				blobId: version.blob_id,
				encryptedMetadata: version.encrypted_metadata,
				reason: version.reason,
				capturedAt: version.captured_at,
			})),
			hasMore,
			nextBefore:
				hasMore && last
					? {
							capturedAt: last.captured_at,
							versionId: last.version_id,
						}
					: null,
		};
	}

	async restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult> {
		const versionHistoryRetentionMs = this.readVersionHistoryRetentionMs();
		const retentionStart = Date.now() - versionHistoryRetentionMs;

		const current = this.entryStore.readEntry(message.entryId);
		if (!current) {
			throw new SyncCoordinatorApplicationError("not_found", {
				message: "entry not found",
			});
		}

		const target = this.historyStore.readEntryVersion(
			message.entryId,
			message.versionId,
			retentionStart,
		);
		if (!target) {
			throw new SyncCoordinatorApplicationError("not_found", {
				message: "requested version was not found",
			});
		}

		if (!isCurrentRevision(current.revision, message.baseRevision)) {
			throw new SyncCoordinatorApplicationError("stale_revision", {
				expectedBaseRevision: current.revision,
				receivedBaseRevision: message.baseRevision,
			});
		}

		if (
			!isRestorePayloadCompatible({
				targetOp: target.op_type,
				targetBlobId: target.blob_id,
				restoreOp: message.op,
				restoreBlobId: message.blobId,
			})
		) {
			throw new SyncCoordinatorApplicationError("version_mismatch", {
				message: "restore payload does not match the requested version",
			});
		}

		const committed = await this.mutationService.commitMutation(
			session,
			{
				type: "commit_mutation",
				requestId: message.requestId,
				mutation: {
					mutationId: crypto.randomUUID(),
					entryId: message.entryId,
					op: message.op,
					baseRevision: message.baseRevision,
					blobId: message.blobId,
					encryptedMetadata: message.encryptedMetadata,
				},
			},
			{
				forcedHistoryBefore: "before_restore",
			},
		);

		if (committed.message.type !== "commit_accepted") {
			throw new SyncCoordinatorApplicationError(
				"code" in committed.message
					? committed.message.code
					: "restore_commit_failed",
				{
					message:
						"message" in committed.message
							? committed.message.message
							: "entry version restore could not be committed",
				},
			);
		}

		return {
			message: {
				type: "entry_version_restored",
				requestId: message.requestId,
				entryId: message.entryId,
				restoredFromVersionId: message.versionId,
				restoredFromRevision: target.source_revision,
				cursor: committed.message.cursor,
				revision: committed.message.revision,
			},
			broadcastCursor: committed.broadcastCursor,
		};
	}

	async restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult> {
		const versionHistoryRetentionMs = this.readVersionHistoryRetentionMs();
		const retentionStart = Date.now() - versionHistoryRetentionMs;
		const results: RestoreEntryVersionBatchResult[] = [];
		const mutationIndexes: number[] = [];
		const restoredFromRevisions: number[] = [];
		const mutations: CommitMutationsMessage["mutations"] = [];

		for (const restore of message.restores) {
			const current = this.entryStore.readEntry(restore.entryId);
			if (!current) {
				results.push(rejectedRestore(restore, "not_found", "entry not found"));
				continue;
			}

			const target = this.historyStore.readEntryVersion(
				restore.entryId,
				restore.versionId,
				retentionStart,
			);
			if (!target) {
				results.push(
					rejectedRestore(restore, "not_found", "requested version was not found"),
				);
				continue;
			}

			if (!isCurrentRevision(current.revision, restore.baseRevision)) {
				results.push({
					status: "rejected",
					entryId: restore.entryId,
					versionId: restore.versionId,
					code: "stale_revision",
					message: `expected base revision ${current.revision} but received ${restore.baseRevision}`,
					expectedBaseRevision: current.revision,
					receivedBaseRevision: restore.baseRevision,
				});
				continue;
			}

			if (
				!isRestorePayloadCompatible({
					targetOp: target.op_type,
					targetBlobId: target.blob_id,
					restoreOp: restore.op,
					restoreBlobId: restore.blobId,
				})
			) {
				results.push(
					rejectedRestore(
						restore,
						"version_mismatch",
						"restore payload does not match the requested version",
					),
				);
				continue;
			}

			mutationIndexes.push(results.length);
			restoredFromRevisions.push(target.source_revision);
			results.push({
				status: "rejected",
				entryId: restore.entryId,
				versionId: restore.versionId,
				code: "restore_commit_pending",
				message: "entry version restore has not been committed",
			});
			mutations.push({
				mutationId: crypto.randomUUID(),
				entryId: restore.entryId,
				op: restore.op,
				baseRevision: restore.baseRevision,
				blobId: restore.blobId,
				encryptedMetadata: restore.encryptedMetadata,
			});
		}

		if (mutations.length === 0) {
			return {
				message: {
					type: "entry_versions_restored",
					requestId: message.requestId,
					cursor: this.vaultStateStore.currentCursor(),
					results,
				},
				broadcastCursor: null,
			};
		}

		const committed = await this.mutationService.commitMutations(
			session,
			{
				type: "commit_mutations",
				requestId: message.requestId,
				mutations,
			},
			{
				forcedHistoryBefore: "before_restore",
			},
		);

		for (let i = 0; i < committed.message.results.length; i += 1) {
			const commitResult = committed.message.results[i];
			const resultIndex = mutationIndexes[i];
			const restore = message.restores[resultIndex];
			if (!commitResult || resultIndex === undefined || !restore) {
				continue;
			}

			results[resultIndex] =
				commitResult.status === "accepted"
					? {
							status: "accepted",
							entryId: restore.entryId,
							restoredFromVersionId: restore.versionId,
							restoredFromRevision: restoredFromRevisions[i] ?? restore.baseRevision,
							cursor: commitResult.cursor,
							revision: commitResult.revision,
						}
					: {
							status: "rejected",
							entryId: restore.entryId,
							versionId: restore.versionId,
							code: commitResult.code,
							message: commitResult.message,
							expectedBaseRevision: commitResult.expectedBaseRevision,
							receivedBaseRevision: commitResult.receivedBaseRevision,
						};
		}

		return {
			message: {
				type: "entry_versions_restored",
				requestId: message.requestId,
				cursor: committed.message.cursor,
				results,
			},
			broadcastCursor: committed.broadcastCursor,
		};
	}

	async purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult> {
		const versionHistoryRetentionMs = this.readVersionHistoryRetentionMs();
		const retentionStart = Date.now() - versionHistoryRetentionMs;
		const results: PurgeDeletedEntryBatchResult[] = [];
		const candidateBlobIds = new Set<string>();
		for (const entry of message.entries) {
			const outcome = this.historyStore.withDeletedEntryPurgeTransaction(
				entry.entryId,
				retentionStart,
				(transaction) => {
					const facts = transaction.readFacts();
					const decision = decideDeletedEntryPurge({
						current: facts.current,
						receivedRevision: entry.revision,
						hasRestorableHistory: facts.hasRestorableHistory,
					});
					switch (decision.kind) {
						case "not_found":
							return {
								result: {
									status: "rejected",
									entryId: entry.entryId,
									code: "not_found",
									message: "entry not found",
								} satisfies PurgeDeletedEntryBatchResult,
								candidateBlobIds: [],
							};
						case "not_deleted":
							return {
								result: {
									status: "rejected",
									entryId: entry.entryId,
									code: "not_deleted",
									message: "entry is not deleted",
								} satisfies PurgeDeletedEntryBatchResult,
								candidateBlobIds: [],
							};
						case "stale_revision":
							return {
								result: {
									status: "rejected",
									entryId: entry.entryId,
									code: "stale_revision",
									message: `expected revision ${decision.expectedRevision} but received ${entry.revision}`,
									expectedRevision: decision.expectedRevision,
								} satisfies PurgeDeletedEntryBatchResult,
								candidateBlobIds: [],
							};
						case "no_history":
							return {
								result: {
									status: "rejected",
									entryId: entry.entryId,
									code: "no_history",
									message: "deleted entry has no restorable history",
								} satisfies PurgeDeletedEntryBatchResult,
								candidateBlobIds: [],
							};
						case "accepted":
							transaction.deleteEntryVersions();
							return {
								result: {
									status: "accepted",
									entryId: entry.entryId,
								} satisfies PurgeDeletedEntryBatchResult,
								candidateBlobIds: facts.candidateBlobIds,
							};
					}
				},
			);
			results.push(outcome.result);
			for (const blobId of outcome.candidateBlobIds) {
				candidateBlobIds.add(blobId);
			}
		}
		const purged = {
			results,
			candidateBlobIds: [...candidateBlobIds],
		};
		await this.blobGcService.collectPurgedBlobs(
			session.vaultId,
			purged.candidateBlobIds,
		);

		return {
			message: {
				type: "deleted_entries_purged",
				requestId: message.requestId,
				results: purged.results,
			},
			candidateBlobIds: purged.candidateBlobIds,
		};
	}

	private readVersionHistoryRetentionMs(): number {
		return this.vaultStateStore.readVersionHistoryRetentionDays() * DAY_IN_MS;
	}
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function validateCursorRange(
	message: ListEntryStatesMessage,
	targetCursor: number,
	currentCursor: number,
): void {
	if (message.sinceCursor > currentCursor) {
		throw new EntrySyncRequestError(
			"cursor_ahead_of_server",
			"Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Synch settings.",
		);
	}

	if (targetCursor < message.sinceCursor || targetCursor > currentCursor) {
		throw new EntrySyncRequestError(
			"invalid_cursor_range",
			`Entry-state cursor range must satisfy sinceCursor <= targetCursor <= currentCursor (${message.sinceCursor} <= ${targetCursor} <= ${currentCursor}).`,
		);
	}

	if (
		message.after !== null &&
		(message.after.updatedSeq <= message.sinceCursor ||
			message.after.updatedSeq > targetCursor)
	) {
		throw new EntrySyncRequestError(
			"invalid_cursor_range",
			`Entry-state page cursor ${message.after.updatedSeq} must be within (${message.sinceCursor}, ${targetCursor}].`,
		);
	}
}

class EntrySyncRequestError extends Error {
	constructor(
		readonly code: "cursor_ahead_of_server" | "invalid_cursor_range",
		message: string,
	) {
		super(message);
		this.name = "EntrySyncRequestError";
	}
}

function rejectedRestore(
	restore: RestoreEntryVersionsMessage["restores"][number],
	code: string,
	message: string,
): RestoreEntryVersionBatchResult {
	return {
		status: "rejected",
		entryId: restore.entryId,
		versionId: restore.versionId,
		code,
		message,
	};
}
