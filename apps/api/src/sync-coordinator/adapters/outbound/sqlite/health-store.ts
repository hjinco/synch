import { eq, gte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type { StorageStatusSnapshot } from "../../../application/dto/types";
import type { VaultHealthSnapshot } from "../../../application/ports/outbound";
import { collectiblePendingDelete } from "./blob-collectability";
import type { CoordinatorStorageHandle } from "./storage-handle";

/** Live websocket count, kept separate from storage since it isn't backed by SQL. */
export interface CoordinatorSocketCounter {
	count(): number;
}

export class CoordinatorHealthStore {
	constructor(
		private readonly handle: CoordinatorStorageHandle,
		private readonly sockets: CoordinatorSocketCounter,
	) {}

	recordGcCompleted(now = Date.now()): void {
		this.handle.db
			.update(doSchema.coordinatorState)
			.set({ lastGcAt: now })
			.where(eq(doSchema.coordinatorState.id, 1))
			.run();
	}

	readHealthSnapshot(
		now: number,
		activeCursorTtlMs: number,
	): VaultHealthSnapshot | null {
		const activeSince = now - activeCursorTtlMs;
		// State row and stats read in one statement so the snapshot observes a
		// single consistent view of all tables.
		const state = this.handle.db
			.select({
				vaultId: doSchema.coordinatorState.vaultId,
				currentCursor: doSchema.coordinatorState.currentCursor,
				storageUsedBytes: doSchema.coordinatorState.storageUsedBytes,
				storageLimitBytes: doSchema.coordinatorState.storageLimitBytes,
				lastCommitAt: doSchema.coordinatorState.lastCommitAt,
				lastGcAt: doSchema.coordinatorState.lastGcAt,
				entryCount: scalarCount(doSchema.entries, eq(doSchema.entries.deleted, 0)),
				liveBlobCount: scalarCount(doSchema.blobs, eq(doSchema.blobs.state, "live")),
				stagedBlobCount: scalarCount(
					doSchema.blobs,
					eq(doSchema.blobs.state, "staged"),
				),
				pendingDeleteBlobCount: scalarCount(
					doSchema.blobs,
					eq(doSchema.blobs.state, "pending_delete"),
				),
				collectiblePendingDeleteBlobCount: scalarCount(
					doSchema.blobs,
					collectiblePendingDelete(now),
				),
				oldestStagedBlobAt: sql<number | null>`(SELECT min(${doSchema.blobs.createdAt}) FROM ${doSchema.blobs} WHERE ${eq(doSchema.blobs.state, "staged")})`,
				oldestPendingDeleteAt: sql<number | null>`(SELECT min(${doSchema.blobs.deleteAfter}) FROM ${doSchema.blobs} WHERE ${collectiblePendingDelete(now)})`,
				activeLocalVaultCount: scalarCount(
					doSchema.localVaultConnections,
					gte(doSchema.localVaultConnections.lastConnectedAt, activeSince),
				),
			})
			.from(doSchema.coordinatorState)
			.where(eq(doSchema.coordinatorState.id, 1))
			.get();
		if (!state) {
			return null;
		}

		const snapshot = {
			vaultId: state.vaultId,
			currentCursor: Number(state.currentCursor),
			entryCount: Number(state.entryCount),
			liveBlobCount: Number(state.liveBlobCount),
			stagedBlobCount: Number(state.stagedBlobCount),
			pendingDeleteBlobCount: Number(state.pendingDeleteBlobCount),
			collectiblePendingDeleteBlobCount: Number(
				state.collectiblePendingDeleteBlobCount,
			),
			storageUsedBytes: Number(state.storageUsedBytes),
			storageLimitBytes: Number(state.storageLimitBytes),
			activeLocalVaultCount: Number(state.activeLocalVaultCount),
			websocketCount: this.sockets.count(),
			oldestStagedBlobAgeMs: ageMs(now, state.oldestStagedBlobAt),
			oldestPendingDeleteAgeMs: ageMs(now, state.oldestPendingDeleteAt),
			lastCommitAt: nullableNumber(state.lastCommitAt),
			lastGcAt: nullableNumber(state.lastGcAt),
		} satisfies VaultHealthSnapshot;

		return snapshot;
	}

	readStorageStatus(): StorageStatusSnapshot {
		const state = this.handle.db
			.select({
				storageUsedBytes: doSchema.coordinatorState.storageUsedBytes,
				storageLimitBytes: doSchema.coordinatorState.storageLimitBytes,
			})
			.from(doSchema.coordinatorState)
			.where(eq(doSchema.coordinatorState.id, 1))
			.get();
		return {
			storageUsedBytes: Number(state?.storageUsedBytes ?? 0),
			storageLimitBytes: Number(state?.storageLimitBytes ?? 0),
		};
	}
}

function scalarCount(
	table: Parameters<ReturnType<CoordinatorStorageHandle["db"]["select"]>["from"]>[0],
	condition: SQL,
): SQL<number> {
	return sql<number>`(SELECT count(*) FROM ${table} WHERE ${condition})`;
}

function nullableNumber(value: number | null): number | null {
	return value === null ? null : Number(value);
}

function ageMs(now: number, timestamp: number | null): number | null {
	if (timestamp === null) {
		return null;
	}
	return Math.max(0, now - Number(timestamp));
}
