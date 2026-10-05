import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import { apiRequest, initializeCoordinatorState } from "../../helpers/api";

export type SyncDoSession = {
	userId: string;
	localVaultId: string;
	vaultId: string;
};

export type SyncMutation = {
	mutationId: string;
	entryId: string;
	op: "upsert" | "delete";
	baseRevision: number;
	blobId: string | null;
	encryptedMetadata: string;
};

export async function uploadBlob(
	vaultId: string,
	syncToken: string,
	blobId: string,
	body: string,
): Promise<void> {
	await initializeCoordinatorState(vaultId);
	const payload = new TextEncoder().encode(body);
	const uploaded = await apiRequest(`/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${blobId}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${syncToken}`,
			"x-blob-size": String(payload.byteLength),
		},
		body: payload,
	});
	expect(uploaded.status).toBe(201);
}

export async function commitMutation(
	stub: DurableObjectStub,
	session: SyncDoSession,
	mutation: SyncMutation,
): Promise<void> {
	await initializeCoordinatorState(session.vaultId);
	const result = await runInDurableObject(stub, async (instance) => {
		const coordinator = instance as unknown as {
			commitMutation: (
				sessionValue: SyncDoSession,
				message: {
					type: "commit_mutation";
					requestId: string;
					mutation: SyncMutation;
				},
			) => Promise<{
				message: { type: string };
			}>;
		};
		return await coordinator.commitMutation(session, {
			type: "commit_mutation",
			requestId: `request-${mutation.mutationId}`,
			mutation,
		});
	});

	expect(result.message.type).toBe("commit_accepted");
}

export async function listEntryStates(
	stub: DurableObjectStub,
	session: SyncDoSession,
	input: {
		sinceCursor: number;
		targetCursor: number | null;
		after: { updatedSeq: number; entryId: string } | null;
		limit: number;
		entryIds?: string[];
	},
): Promise<{
	type: "entry_states_listed";
	requestId: string;
	targetCursor: number;
	hasMore: boolean;
	nextAfter: { updatedSeq: number; entryId: string } | null;
	entries: Array<{
		entryId: string;
		revision: number;
		blobId: string | null;
		encryptedMetadata: string;
		deleted: boolean;
		updatedSeq: number;
		updatedAt: number;
	}>;
}> {
	return await runInDurableObject(stub, async (instance) => {
		const coordinator = instance as unknown as {
			listEntryStates: (
				sessionValue: SyncDoSession,
				message: {
					type: "list_entry_states";
					requestId: string;
					sinceCursor: number;
					targetCursor: number | null;
					after: { updatedSeq: number; entryId: string } | null;
					limit: number;
					entryIds?: string[];
				},
			) => Promise<{
				type: "entry_states_listed";
				requestId: string;
				targetCursor: number;
				hasMore: boolean;
				nextAfter: { updatedSeq: number; entryId: string } | null;
				entries: Array<{
					entryId: string;
					revision: number;
					blobId: string | null;
					encryptedMetadata: string;
					deleted: boolean;
					updatedSeq: number;
					updatedAt: number;
				}>;
			}>;
		};
		return await coordinator.listEntryStates(session, {
			type: "list_entry_states",
			requestId: `request-entry-states-${input.sinceCursor}`,
			sinceCursor: input.sinceCursor,
			targetCursor: input.targetCursor,
			after: input.after,
			limit: input.limit,
			...(input.entryIds ? { entryIds: input.entryIds } : {}),
		});
	});
}

export async function listEntryVersions(
	stub: DurableObjectStub,
	session: SyncDoSession,
	input: {
		entryId: string;
		before: { capturedAt: number; versionId: string } | null;
		limit: number;
	},
): Promise<{
	type: "entry_versions_listed";
	requestId: string;
	entryId: string;
	versions: Array<{
		versionId: string;
		sourceRevision: number;
		op: "upsert" | "delete";
		blobId: string | null;
		encryptedMetadata: string;
		reason: "auto" | "before_delete" | "before_restore" | "manual";
		capturedAt: number;
	}>;
	hasMore: boolean;
	nextBefore: { capturedAt: number; versionId: string } | null;
}> {
	return await runInDurableObject(stub, async (instance) => {
		const coordinator = instance as unknown as {
			listEntryVersions: (
				sessionValue: SyncDoSession,
				message: {
					type: "list_entry_versions";
					requestId: string;
					entryId: string;
					before: { capturedAt: number; versionId: string } | null;
					limit: number;
				},
			) => Promise<{
				type: "entry_versions_listed";
				requestId: string;
				entryId: string;
				versions: Array<{
					versionId: string;
					sourceRevision: number;
					op: "upsert" | "delete";
					blobId: string | null;
					encryptedMetadata: string;
					reason: "auto" | "before_delete" | "before_restore" | "manual";
					capturedAt: number;
				}>;
				hasMore: boolean;
				nextBefore: { capturedAt: number; versionId: string } | null;
			}>;
		};
		return await coordinator.listEntryVersions(session, {
			type: "list_entry_versions",
			requestId: `request-history-${input.entryId}`,
			entryId: input.entryId,
			before: input.before,
			limit: input.limit,
		});
	});
}

export async function listDeletedEntries(
	stub: DurableObjectStub,
	session: SyncDoSession,
	input: {
		before: { deletedAt: number; entryId: string } | null;
		limit: number;
	},
): Promise<{
	type: "deleted_entries_listed";
	requestId: string;
	entries: Array<{
		entryId: string;
		revision: number;
		encryptedMetadata: string;
		deletedAt: number;
	}>;
	hasMore: boolean;
	nextBefore: { deletedAt: number; entryId: string } | null;
}> {
	return await runInDurableObject(stub, async (instance) => {
		const coordinator = instance as unknown as {
			listDeletedEntries: (
				sessionValue: SyncDoSession,
				message: {
					type: "list_deleted_entries";
					requestId: string;
					before: { deletedAt: number; entryId: string } | null;
					limit: number;
				},
			) => Promise<{
				type: "deleted_entries_listed";
				requestId: string;
				entries: Array<{
					entryId: string;
					revision: number;
					encryptedMetadata: string;
					deletedAt: number;
				}>;
				hasMore: boolean;
				nextBefore: { deletedAt: number; entryId: string } | null;
			}>;
		};
		return await coordinator.listDeletedEntries(session, {
			type: "list_deleted_entries",
			requestId: "request-deleted-entries",
			before: input.before,
			limit: input.limit,
		});
	});
}

export async function restoreEntryVersion(
	stub: DurableObjectStub,
	session: SyncDoSession,
	input: {
		entryId: string;
		versionId: string;
		baseRevision: number;
		op: "upsert" | "delete";
		blobId: string | null;
		encryptedMetadata: string;
	},
): Promise<{
	message: {
		type: "entry_version_restored";
		requestId: string;
		entryId: string;
		restoredFromVersionId: string;
		restoredFromRevision: number;
		cursor: number;
		revision: number;
	};
	broadcastCursor: number | null;
}> {
	return await runInDurableObject(stub, async (instance) => {
		const coordinator = instance as unknown as {
			restoreEntryVersion: (
				sessionValue: SyncDoSession,
				message: {
					type: "restore_entry_version";
					requestId: string;
					entryId: string;
					versionId: string;
					baseRevision: number;
					op: "upsert" | "delete";
					blobId: string | null;
					encryptedMetadata: string;
				},
			) => Promise<{
				message: {
					type: "entry_version_restored";
					requestId: string;
					entryId: string;
					restoredFromVersionId: string;
					restoredFromRevision: number;
					cursor: number;
					revision: number;
				};
				broadcastCursor: number | null;
			}>;
		};
		return await coordinator.restoreEntryVersion(session, {
			type: "restore_entry_version",
			requestId: `request-restore-${input.entryId}-${input.versionId}`,
			entryId: input.entryId,
			versionId: input.versionId,
			baseRevision: input.baseRevision,
			op: input.op,
			blobId: input.blobId,
			encryptedMetadata: input.encryptedMetadata,
		});
	});
}

export async function purgeDeletedEntries(
	stub: DurableObjectStub,
	session: SyncDoSession,
	entries: Array<{ entryId: string; revision: number }>,
): Promise<{
	message: {
		type: "deleted_entries_purged";
		requestId: string;
		results: Array<
			| {
					status: "accepted";
					entryId: string;
			  }
			| {
					status: "rejected";
					entryId: string;
					code: string;
					message: string;
					expectedRevision?: number;
			  }
		>;
	};
	candidateBlobIds: string[];
}> {
	return await runInDurableObject(stub, async (instance) => {
		const coordinator = instance as unknown as {
			purgeDeletedEntries: (
				sessionValue: SyncDoSession,
				message: {
					type: "purge_deleted_entries";
					requestId: string;
					entries: Array<{ entryId: string; revision: number }>;
				},
			) => Promise<{
				message: {
					type: "deleted_entries_purged";
					requestId: string;
					results: Array<
						| {
								status: "accepted";
								entryId: string;
						  }
						| {
								status: "rejected";
								entryId: string;
								code: string;
								message: string;
								expectedRevision?: number;
						  }
					>;
				};
				candidateBlobIds: string[];
			}>;
		};
		return await coordinator.purgeDeletedEntries(session, {
			type: "purge_deleted_entries",
			requestId: "request-purge-deleted-entries",
			entries,
		});
	});
}
