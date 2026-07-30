import { and, eq } from "drizzle-orm";

import * as doSchema from "../../../db/do";
import type { VaultStateLimits } from "../types";
import type { CoordinatorDb, CoordinatorStorageHandle } from "./storage-handle";

type CursorDb = Pick<CoordinatorDb, "insert" | "select">;

export class CoordinatorCursorStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	currentCursor(): number {
		return currentCursor(this.handle.db);
	}

	ensureVaultState(vaultId: string, initialLimits: VaultStateLimits): void {
		ensureVaultState(this.handle.db, vaultId, initialLimits);
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

	recordLocalVaultConnection(userId: string, localVaultId: string): void {
		recordLocalVaultConnection(this.handle.db, userId, localVaultId, Date.now());
	}

	deleteLocalVaultConnection(userId: string, localVaultId: string): void {
		this.handle.db
			.delete(doSchema.localVaultConnections)
			.where(
				and(
					eq(doSchema.localVaultConnections.userId, userId),
					eq(doSchema.localVaultConnections.localVaultId, localVaultId),
				),
			)
			.run();
	}

	currentCursorInTransaction(db: CursorDb): number {
		return currentCursor(db);
	}

}

function ensureVaultState(
	db: CursorDb,
	vaultId: string,
	initialLimits: VaultStateLimits,
): void {
	const existing = db
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

	db.insert(doSchema.coordinatorState)
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

function currentCursor(db: CursorDb): number {
	const state = db
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

function recordLocalVaultConnection(
	db: CursorDb,
	userId: string,
	localVaultId: string,
	lastConnectedAt: number,
): void {
	db.insert(doSchema.localVaultConnections)
		.values({
			userId,
			localVaultId,
			lastConnectedAt,
		})
		.onConflictDoUpdate({
			target: [
				doSchema.localVaultConnections.userId,
				doSchema.localVaultConnections.localVaultId,
			],
			set: {
				lastConnectedAt,
			},
		})
		.run();
}
