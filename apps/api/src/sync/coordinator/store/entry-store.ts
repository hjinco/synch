import { eq } from "drizzle-orm";

import * as doSchema from "../../../db/do";
import type {
	CurrentEntryRow,
	DeletedEntryListRow,
	DeletedEntryPageCursor,
	EntryStatePageCursor,
	EntryStateRow,
} from "../types";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class CoordinatorEntryStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	listEntryStates(
		sinceCursor: number,
		targetCursor: number,
		after: EntryStatePageCursor | null,
		limit: number,
	): EntryStateRow[] {
		const rows = this.handle
			.exec<{
				entry_id: string;
				revision: number;
				blob_id: string | null;
				encrypted_metadata: string;
				deleted: number;
				updated_seq: number;
				updated_at: number;
			}>(
				`
				SELECT
					entry_id,
					revision,
					blob_id,
					encrypted_metadata,
					deleted,
					updated_seq,
					updated_at
				FROM entries
				WHERE updated_seq > ?
					AND updated_seq <= ?
					AND (
						? IS NULL
						OR updated_seq > ?
						OR (updated_seq = ? AND entry_id > ?)
					)
				ORDER BY updated_seq ASC, entry_id ASC
				LIMIT ?
				`,
				sinceCursor,
				targetCursor,
				after?.updatedSeq ?? null,
				after?.updatedSeq ?? null,
				after?.updatedSeq ?? null,
				after?.entryId ?? null,
				limit,
			)
			.toArray();

		return rows.map((row) => ({
			entry_id: row.entry_id,
			revision: Number(row.revision),
			blob_id: row.blob_id,
			encrypted_metadata: row.encrypted_metadata,
			deleted: Number(row.deleted) !== 0,
			updated_seq: Number(row.updated_seq),
			updated_at: Number(row.updated_at),
		}));
	}

	countEntryStates(sinceCursor: number, targetCursor: number): number {
		const row = this.handle
			.exec<{ total: number }>(
				`
				SELECT COUNT(*) AS total
				FROM entries
				WHERE updated_seq > ?
					AND updated_seq <= ?
				`,
				sinceCursor,
				targetCursor,
			)
			.one();

		return Number(row.total);
	}

	listDeletedEntries(
		before: DeletedEntryPageCursor | null,
		retentionStart: number,
		limit: number,
	): DeletedEntryListRow[] {
		const rows = this.handle
			.exec<{
				entry_id: string;
				revision: number;
				encrypted_metadata: string;
				deleted_at: number;
			}>(
				`
				SELECT
					entry_id,
					revision,
					encrypted_metadata,
					updated_at AS deleted_at
				FROM entries
				WHERE deleted = 1
					AND revision > 0
					AND (
						? IS NULL
						OR updated_at < ?
						OR (updated_at = ? AND entry_id < ?)
					)
					AND EXISTS (
						SELECT 1
						FROM entry_versions
						WHERE entry_versions.entry_id = entries.entry_id
							AND entry_versions.op_type = 'upsert'
							AND entry_versions.blob_id IS NOT NULL
							AND entry_versions.captured_at >= ?
					)
				ORDER BY updated_at DESC, entry_id DESC
				LIMIT ?
				`,
				before?.deletedAt ?? null,
				before?.deletedAt ?? null,
				before?.deletedAt ?? null,
				before?.entryId ?? null,
				retentionStart,
				limit,
			)
			.toArray();

		return rows.map((row) => ({
			entry_id: row.entry_id,
			revision: Number(row.revision),
			encrypted_metadata: row.encrypted_metadata,
			deleted_at: Number(row.deleted_at),
		}));
	}

	readEntry(entryId: string): CurrentEntryRow | null {
		const row = this.handle.db
			.select({
				entry_id: doSchema.entries.entryId,
				revision: doSchema.entries.revision,
				blob_id: doSchema.entries.blobId,
				encrypted_metadata: doSchema.entries.encryptedMetadata,
				deleted: doSchema.entries.deleted,
			})
			.from(doSchema.entries)
			.where(eq(doSchema.entries.entryId, entryId))
			.limit(1)
			.get();

		return row
			? {
					entry_id: row.entry_id,
					revision: Number(row.revision),
					blob_id: row.blob_id,
					encrypted_metadata: row.encrypted_metadata,
					deleted: Number(row.deleted),
				}
			: null;
	}

}
