import type { BlobLifecycleState } from "../../../domain/blob-policy";
import type { EntryVersionCaptureReason } from "../../../domain/entry-policy";

export type CurrentEntryRow = {
	entry_id: string;
	revision: number;
	blob_id: string | null;
	encrypted_metadata: string;
	deleted: number;
};

export type EntryVersionReason = EntryVersionCaptureReason;

export type EntryVersionRow = {
	version_id: string;
	entry_id: string;
	source_revision: number;
	op_type: "upsert" | "delete";
	blob_id: string | null;
	encrypted_metadata: string;
	reason: EntryVersionReason;
	bucket_start_ms: number | null;
	captured_at: number;
	created_by_user_id: string;
	created_by_local_vault_id: string;
};

export type EntryVersionListRow = Pick<
	EntryVersionRow,
	| "version_id"
	| "entry_id"
	| "source_revision"
	| "op_type"
	| "blob_id"
	| "encrypted_metadata"
	| "reason"
	| "captured_at"
>;

export type EntryStateRow = {
	entry_id: string;
	revision: number;
	blob_id: string | null;
	encrypted_metadata: string;
	deleted: boolean;
	updated_seq: number;
	updated_at: number;
};

export type DeletedEntryListRow = {
	entry_id: string;
	revision: number;
	encrypted_metadata: string;
	deleted_at: number;
};

export type BlobState = BlobLifecycleState;

export type BlobRow = {
	blob_id: string;
	state: BlobState;
	size_bytes: number;
	created_at: number;
	last_uploaded_at: number;
	delete_after: number | null;
};
