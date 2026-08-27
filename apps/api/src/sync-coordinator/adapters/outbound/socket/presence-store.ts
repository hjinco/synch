import type { PresenceSelection } from "../../../application/dto/protocol-types";

export const MIN_PRESENCE_UPDATE_INTERVAL_MS = 200;
export type PresenceStoreDecision = "ok" | "throttled";

export type StoredPresencePayload = {
	presenceId: string;
	entryId: string;
	selection: PresenceSelection;
};

export class PresenceStore {
	private readonly payloads = new Map<string, StoredPresencePayload>();
	private readonly lastUpdateAt = new Map<string, number>();

	tryStore(
		presenceId: string,
		entryId: string,
		selection: PresenceSelection,
		now = Date.now(),
	): PresenceStoreDecision {
		const previousUpdateAt = this.lastUpdateAt.get(presenceId);
		if (
			previousUpdateAt !== undefined &&
			now - previousUpdateAt < MIN_PRESENCE_UPDATE_INTERVAL_MS
		) {
			return "throttled";
		}

		this.payloads.set(presenceId, { presenceId, entryId, selection });
		this.lastUpdateAt.set(presenceId, now);
		return "ok";
	}

	get(presenceId: string): StoredPresencePayload | null {
		return this.payloads.get(presenceId) ?? null;
	}

	listByEntryId(entryId: string, exceptPresenceId?: string): StoredPresencePayload[] {
		const snapshots: StoredPresencePayload[] = [];
		for (const [id, payload] of this.payloads) {
			if (id === exceptPresenceId || payload.entryId !== entryId) {
				continue;
			}
			snapshots.push(payload);
		}
		return snapshots;
	}

	clear(presenceId: string): StoredPresencePayload | null {
		this.lastUpdateAt.delete(presenceId);
		const previous = this.get(presenceId);
		this.payloads.delete(presenceId);
		return previous;
	}

	clearAll(): void {
		this.payloads.clear();
		this.lastUpdateAt.clear();
	}
}
