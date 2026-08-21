/**
 * Blob is not referenced by a current entry or an unexpired version.
 * Requires the `blobs` table in scope. Binds `now` once for `expires_at`.
 */
export const BLOB_UNREFERENCED_SQL = `
	NOT EXISTS (
		SELECT 1
		FROM entries
		WHERE entries.blob_id = blobs.blob_id
	)
	AND NOT EXISTS (
		SELECT 1
		FROM entry_versions
		WHERE entry_versions.blob_id = blobs.blob_id
			AND entry_versions.expires_at > ?
	)
`;

/**
 * Staged or pending_delete blob whose grace period has passed and is unreferenced.
 * Binds `now` twice: `delete_after` cutoff, then version `expires_at` cutoff.
 */
export const COLLECTIBLE_BLOB_SQL = `
	blobs.state IN ('staged', 'pending_delete')
	AND blobs.delete_after <= ?
	AND ${BLOB_UNREFERENCED_SQL}
`;

/**
 * Pending-delete blob that GC can collect right now.
 * Binds `now` twice: `delete_after` cutoff, then version `expires_at` cutoff.
 */
export const COLLECTIBLE_PENDING_DELETE_SQL = `
	blobs.state = 'pending_delete'
	AND blobs.delete_after <= ?
	AND ${BLOB_UNREFERENCED_SQL}
`;
