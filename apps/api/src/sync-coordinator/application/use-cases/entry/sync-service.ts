import type {
	EntryStatesListedMessage,
	ListEntryStatesMessage,
	SocketSession,
} from "../../dto/types";
import type { EntryStateStore, VaultStateStore } from "../../ports/outbound";

const MAX_ENTRY_STATE_BATCH = 500;

export class EntrySyncService {
	constructor(
		private readonly entryStore: EntryStateStore,
		private readonly vaultStateStore: Pick<VaultStateStore, "currentCursor">,
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
}

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
