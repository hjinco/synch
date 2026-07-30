import type {
	EntryVersionListRow,
	EntryVersionPageCursor,
	EntryVersionReason,
	EntryVersionRow,
	PurgeDeletedEntryBatchResult,
} from "../types";
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

	purgeDeletedEntryVersions(
		entries: Array<{ entryId: string; revision: number }>,
		retentionStart: number,
	): {
		results: PurgeDeletedEntryBatchResult[];
		candidateBlobIds: string[];
	} {
		const results: PurgeDeletedEntryBatchResult[] = [];
		const candidateBlobIds = new Set<string>();

		for (const entry of entries) {
			const current = this.handle
				.exec<{
					revision: number;
					deleted: number;
				}>(
					`
					SELECT revision, deleted
					FROM entries
					WHERE entry_id = ?
					LIMIT 1
					`,
					entry.entryId,
				)
				.toArray()[0];
			if (!current) {
				results.push({
					status: "rejected",
					entryId: entry.entryId,
					code: "not_found",
					message: "entry not found",
				});
				continue;
			}

			const currentRevision = Number(current.revision);
			if (Number(current.deleted) !== 1) {
				results.push({
					status: "rejected",
					entryId: entry.entryId,
					code: "not_deleted",
					message: "entry is not deleted",
				});
				continue;
			}

			if (currentRevision !== entry.revision) {
				results.push({
					status: "rejected",
					entryId: entry.entryId,
					code: "stale_revision",
					message: `expected revision ${currentRevision} but received ${entry.revision}`,
					expectedRevision: currentRevision,
				});
				continue;
			}

			const restorable = this.handle
				.exec<{ found: number }>(
					`
					SELECT 1 AS found
					FROM entry_versions
					WHERE entry_id = ?
						AND op_type = 'upsert'
						AND blob_id IS NOT NULL
						AND captured_at >= ?
					LIMIT 1
					`,
					entry.entryId,
					retentionStart,
				)
				.toArray()[0];
			if (!restorable) {
				results.push({
					status: "rejected",
					entryId: entry.entryId,
					code: "no_history",
					message: "deleted entry has no restorable history",
				});
				continue;
			}

			for (const version of this.handle
				.exec<{ blob_id: string | null }>(
					`
					SELECT DISTINCT blob_id
					FROM entry_versions
					WHERE entry_id = ?
						AND blob_id IS NOT NULL
					`,
					entry.entryId,
				)
				.toArray()) {
				if (version.blob_id) {
					candidateBlobIds.add(version.blob_id);
				}
			}

			this.handle.exec(
				`
				DELETE FROM entry_versions
				WHERE entry_id = ?
				`,
				entry.entryId,
			);
			results.push({
				status: "accepted",
				entryId: entry.entryId,
			});
		}

		return {
			results,
			candidateBlobIds: [...candidateBlobIds],
		};
	}
}
