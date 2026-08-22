import { and, eq, gte, isNotNull, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type { EntryVersionPageCursor } from "../../../application/dto/types";
import type {
	DeletedEntryPurgeFacts,
	DeletedEntryPurgeTransaction,
} from "../../../application/ports/outbound/entry-store";
import type {
	EntryVersionListRow,
	EntryVersionReason,
	EntryVersionRow,
} from "../../../application/ports/outbound/storage-models";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class CoordinatorHistoryStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	listEntryVersions(
		entryId: string,
		before: EntryVersionPageCursor | null,
		retentionStart: number,
		limit: number,
	): EntryVersionListRow[] {
		const rows = this.handle
			.exec<{
				version_id: string;
				entry_id: string;
				source_revision: number;
				op_type: string;
				blob_id: string | null;
				encrypted_metadata: string;
				reason: string;
				captured_at: number;
			}>(
				`
				SELECT
					version_id,
					entry_id,
					source_revision,
					op_type,
					blob_id,
					encrypted_metadata,
					reason,
					captured_at
				FROM entry_versions
				WHERE entry_id = ?
					AND captured_at >= ?
					AND (
						? IS NULL
						OR captured_at < ?
						OR (captured_at = ? AND version_id < ?)
					)
				ORDER BY captured_at DESC, version_id DESC
				LIMIT ?
				`,
				entryId,
				retentionStart,
				before?.capturedAt ?? null,
				before?.capturedAt ?? null,
				before?.capturedAt ?? null,
				before?.versionId ?? null,
				limit,
			)
			.toArray();

		return rows.map((row) => ({
			version_id: row.version_id,
			entry_id: row.entry_id,
			source_revision: Number(row.source_revision),
			op_type: row.op_type as EntryVersionRow["op_type"],
			blob_id: row.blob_id,
			encrypted_metadata: row.encrypted_metadata,
			reason: row.reason as EntryVersionReason,
			captured_at: Number(row.captured_at),
		}));
	}

	readEntryVersion(
		entryId: string,
		versionId: string,
		retentionStart: number,
	): EntryVersionRow | null {
		const row = this.handle
			.exec<{
				version_id: string;
				entry_id: string;
				source_revision: number;
				op_type: string;
				blob_id: string | null;
				encrypted_metadata: string;
				reason: string;
				bucket_start_ms: number | null;
				captured_at: number;
				created_by_user_id: string;
				created_by_local_vault_id: string;
			}>(
				`
				SELECT *
				FROM entry_versions
				WHERE entry_id = ?
					AND version_id = ?
					AND captured_at >= ?
				LIMIT 1
				`,
				entryId,
				versionId,
				retentionStart,
			)
			.toArray()[0];

		return row
			? {
					version_id: row.version_id,
					entry_id: row.entry_id,
					source_revision: Number(row.source_revision),
					op_type: row.op_type as EntryVersionRow["op_type"],
					blob_id: row.blob_id,
					encrypted_metadata: row.encrypted_metadata,
					reason: row.reason as EntryVersionReason,
					bucket_start_ms:
						row.bucket_start_ms === null ? null : Number(row.bucket_start_ms),
					captured_at: Number(row.captured_at),
					created_by_user_id: row.created_by_user_id,
					created_by_local_vault_id: row.created_by_local_vault_id,
				}
			: null;
	}

	withDeletedEntryPurgeTransaction<T>(
		entryId: string,
		retentionStart: number,
		operation: (transaction: DeletedEntryPurgeTransaction) => T,
	): T {
		return this.handle.db.transaction((tx) => {
			const transaction: DeletedEntryPurgeTransaction = {
				readFacts: (): DeletedEntryPurgeFacts => {
					const current = tx
						.select({
							revision: doSchema.entries.revision,
							deleted: doSchema.entries.deleted,
						})
						.from(doSchema.entries)
						.where(eq(doSchema.entries.entryId, entryId))
						.limit(1)
						.get();
					const hasRestorableHistory = tx
						.select({ found: sql<number>`1` })
						.from(doSchema.entryVersions)
						.where(
							and(
								eq(doSchema.entryVersions.entryId, entryId),
								eq(doSchema.entryVersions.opType, "upsert"),
								isNotNull(doSchema.entryVersions.blobId),
								gte(doSchema.entryVersions.capturedAt, retentionStart),
							),
						)
						.limit(1)
						.get();
					const candidateBlobIds = tx
						.select({ blobId: doSchema.entryVersions.blobId })
						.from(doSchema.entryVersions)
						.where(
							and(
								eq(doSchema.entryVersions.entryId, entryId),
								isNotNull(doSchema.entryVersions.blobId),
							),
						)
						.all()
						.flatMap((row) => (row.blobId ? [row.blobId] : []));

					return {
						current: current
							? {
									revision: Number(current.revision),
									deleted: Number(current.deleted) === 1,
								}
							: null,
						hasRestorableHistory: Boolean(hasRestorableHistory),
						candidateBlobIds: [...new Set(candidateBlobIds)],
					};
				},
				deleteEntryVersions: () => {
					tx.delete(doSchema.entryVersions)
						.where(eq(doSchema.entryVersions.entryId, entryId))
						.run();
				},
			};

			return operation(transaction);
		});
	}
}
