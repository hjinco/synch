import { eq, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type { SyncPauseState } from "../../../application/ports/outbound";
import type { VaultStateLimits } from "../../../application/dto/types";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class CoordinatorStateStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	recordGcCompleted(now: number): void {
		this.handle.db
			.update(doSchema.coordinatorState)
			.set({ lastGcAt: now })
			.where(eq(doSchema.coordinatorState.id, 1))
			.run();
	}

	currentCursor(): number {
		const state = this.handle.db
			.select({
				cursor: doSchema.coordinatorState.currentCursor,
			})
			.from(doSchema.coordinatorState)
			.where(eq(doSchema.coordinatorState.id, 1))
			.limit(1)
			.get();
		if (state) {
			return Number(state.cursor);
		}

		throw new Error("vault sync state is not initialized");
	}

	ensureVaultState(vaultId: string, initialLimits: VaultStateLimits): void {
		const existing = this.handle.db
			.select({
				vaultId: doSchema.coordinatorState.vaultId,
			})
			.from(doSchema.coordinatorState)
			.where(eq(doSchema.coordinatorState.id, 1))
			.limit(1)
			.get();
		if (existing) {
			if (existing.vaultId !== vaultId) {
				throw new Error("durable object vault id mismatch");
			}
			return;
		}

		this.handle.db
			.insert(doSchema.coordinatorState)
			.values({
				id: 1,
				vaultId,
				currentCursor: 0,
				storageLimitBytes: initialLimits.storageLimitBytes,
				maxFileSizeBytes: initialLimits.maxFileSizeBytes,
				versionHistoryRetentionDays: initialLimits.versionHistoryRetentionDays,
			})
			.run();
	}

	readVaultId(): string | null {
		const row = this.handle.db
			.select({
				vaultId: doSchema.coordinatorState.vaultId,
			})
			.from(doSchema.coordinatorState)
			.where(eq(doSchema.coordinatorState.id, 1))
			.limit(1)
			.get();
		return row?.vaultId ?? null;
	}

	readSyncPause(): SyncPauseState | null {
		const row = this.handle
			.exec<{
				sync_paused_at: number | null;
				sync_pause_reason: string | null;
			}>(
				`
				SELECT sync_paused_at, sync_pause_reason
				FROM coordinator_state
				WHERE id = 1
				`,
			)
			.toArray()[0];
		if (row?.sync_paused_at === null || row?.sync_paused_at === undefined) {
			return null;
		}

		return {
			pausedAt: Number(row.sync_paused_at),
			reason: row.sync_pause_reason ?? "vault sync paused",
		};
	}

	clearSyncPause(): void {
		this.handle.exec(
			`
			UPDATE coordinator_state
			SET sync_paused_at = NULL,
				sync_pause_reason = NULL
			WHERE id = 1
			`,
		);
	}

	vaultStateExistsFor(vaultId: string): boolean {
		const existingVaultId = this.readVaultId();
		if (!existingVaultId) {
			return false;
		}
		if (existingVaultId !== vaultId) {
			throw new Error("durable object vault id mismatch");
		}
		return true;
	}

	readVaultLimits(): VaultStateLimits {
		const row = this.handle
			.exec<{
				storage_limit_bytes: number;
				max_file_size_bytes: number;
				version_history_retention_days: number;
			}>(
				`
				SELECT
					storage_limit_bytes,
					max_file_size_bytes,
					version_history_retention_days
				FROM coordinator_state
				WHERE id = 1
				`,
			)
			.toArray()[0];
		if (!row) {
			throw new Error("vault sync state is not initialized");
		}
		return {
			storageLimitBytes: Number(row.storage_limit_bytes),
			maxFileSizeBytes: Number(row.max_file_size_bytes),
			versionHistoryRetentionDays: Number(row.version_history_retention_days),
		};
	}

	applyVaultPolicy(vaultId: string, limits: VaultStateLimits): boolean {
		const existingVaultId = this.readVaultId();
		if (!existingVaultId) {
			return false;
		}
		if (existingVaultId !== vaultId) {
			throw new Error("durable object vault id mismatch");
		}

		this.handle.exec(
			`
			UPDATE coordinator_state
			SET
				storage_limit_bytes = ?,
				max_file_size_bytes = ?,
				version_history_retention_days = ?
			WHERE id = 1
			`,
			limits.storageLimitBytes,
			limits.maxFileSizeBytes,
			limits.versionHistoryRetentionDays,
		);
		return true;
	}

	readVersionHistoryRetentionDays(): number {
		return this.readVaultLimits().versionHistoryRetentionDays;
	}

	readStorageUsedBytes(): number {
		const row = this.handle.db
			.select({ used: doSchema.coordinatorState.storageUsedBytes })
			.from(doSchema.coordinatorState)
			.where(eq(doSchema.coordinatorState.id, 1))
			.get();
		if (!row) throw new Error("vault sync state is not initialized");
		return Number(row.used);
	}
	adjustStorageUsedBytes(delta: number): void {
		this.handle.db
			.update(doSchema.coordinatorState)
			.set({
				storageUsedBytes: sql`max(0, ${doSchema.coordinatorState.storageUsedBytes} + ${delta})`,
			})
			.where(eq(doSchema.coordinatorState.id, 1))
			.run();
	}
	pauseSync(now: number, reason: string): void {
		this.handle.db
			.update(doSchema.coordinatorState)
			.set({
				syncPausedAt: sql`coalesce(${doSchema.coordinatorState.syncPausedAt}, ${now})`,
				syncPauseReason: sql`coalesce(${doSchema.coordinatorState.syncPauseReason}, ${reason})`,
			})
			.where(eq(doSchema.coordinatorState.id, 1))
			.run();
	}
	saveCommit(cursor: number, now: number): void {
		this.handle.db
			.update(doSchema.coordinatorState)
			.set({ currentCursor: cursor, lastCommitAt: now })
			.where(eq(doSchema.coordinatorState.id, 1))
			.run();
	}
}
