import { describe, expect, it, vi } from "vitest";

import {
	ACTIVE_WITHOUT_RECENT_COMMIT_MS,
	PENDING_DELETE_STALE_MS,
} from "../../domain/health-policy";
import { HealthService } from "./health-service";
import type { HealthStateStore, VaultHealthSnapshot } from "../ports/outbound";

describe("HealthService", () => {
	it("coalesces delayed health summary flush scheduling", async () => {
		const stateRepository = createStateRepository();
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			stateRepository,
			null,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await service.scheduleSummaryFlush(1_000);
		await service.scheduleSummaryFlush(30_000);
		await service.scheduleSummaryFlush(60_999);

		expect(deferMaintenance).toHaveBeenCalledTimes(1);
		expect(deferMaintenance).toHaveBeenCalledWith(
			"health_summary_flush",
			601_000,
			1_000,
		);
	});

	it("keeps the earliest scheduled flush after later activity", async () => {
		const stateRepository = createStateRepository();
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			stateRepository,
			null,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await service.scheduleSummaryFlush(1_000);
		await service.scheduleSummaryFlush(61_000);

		expect(deferMaintenance).toHaveBeenCalledTimes(1);
	});

	it("allows the next activity to schedule after a successful flush", async () => {
		const stateRepository = createStateRepository({
			readHealthSnapshot: vi.fn(() => createSnapshot({ lastCommitAt: 1_000 })),
		});
		const syncStatusRepository = {
			upsert: vi.fn(async () => {}),
		};
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			stateRepository,
			syncStatusRepository,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await service.scheduleSummaryFlush(1_000);
		await service.flushSummary({ now: 61_000 });
		await service.scheduleSummaryFlush(62_000);

		expect(deferMaintenance).toHaveBeenCalledTimes(3);
		expect(deferMaintenance).toHaveBeenNthCalledWith(
			2,
			"health_summary_flush",
			1_000 + ACTIVE_WITHOUT_RECENT_COMMIT_MS,
			61_000,
		);
	});

	it("returns and arms the next deadline flush after a successful upsert", async () => {
		const lastCommitAt = 1_000;
		const now = 61_000;
		const stateRepository = createStateRepository({
			readHealthSnapshot: vi.fn(() => createSnapshot({ lastCommitAt })),
		});
		const syncStatusRepository = {
			upsert: vi.fn(async () => {}),
		};
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			stateRepository,
			syncStatusRepository,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		const nextDueAt = await service.flushSummary({ now });

		expect(nextDueAt).toBe(lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS);
		expect(deferMaintenance).toHaveBeenCalledWith(
			"health_summary_flush",
			lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS,
			now,
		);
	});

	it("evaluates health policy before persisting the summary", async () => {
		const now = PENDING_DELETE_STALE_MS;
		const upsert = vi.fn(async () => {});
		const service = new HealthService(
			createStateRepository({
				readHealthSnapshot: vi.fn(() =>
					createSnapshot({
						activeLocalVaultCount: 0,
						lastCommitAt: null,
						collectiblePendingDeleteBlobCount: 1,
						oldestPendingDeleteAgeMs: PENDING_DELETE_STALE_MS,
					}),
				),
			}),
			{ upsert },
			30 * 24 * 60 * 60 * 1000,
			{ defer: vi.fn(async () => {}) },
		);

		await service.flushSummary({ now });

		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				healthStatus: "warning",
				healthReasons: ["pending_delete_stale"],
			}),
			now,
		);
	});

	it("does not arm another flush when no future health deadline remains", async () => {
		const lastCommitAt = 1_000;
		const now = lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		const upsert = vi.fn(async () => {});
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			createStateRepository({
				readHealthSnapshot: vi.fn(() => createSnapshot({ lastCommitAt })),
			}),
			{ upsert },
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await expect(service.flushSummary({ now })).resolves.toBeNull();
		expect(deferMaintenance).not.toHaveBeenCalled();
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				healthStatus: "warning",
				healthReasons: ["active_without_recent_commit"],
			}),
			now,
		);
	});

	it("re-arms an immediate flush when persistence fails", async () => {
		const now = 61_000;
		const failure = new Error("status write failed");
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			createStateRepository({
				readHealthSnapshot: vi.fn(() => createSnapshot({ lastCommitAt: 1_000 })),
			}),
			{
				upsert: vi.fn(async () => {
					throw failure;
				}),
			},
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await expect(service.flushSummary({ now })).resolves.toBeNull();
		expect(deferMaintenance).toHaveBeenCalledWith("health_summary_flush", now, now);

		await service.scheduleSummaryFlush(now);
		expect(deferMaintenance).toHaveBeenCalledWith(
			"health_summary_flush",
			now + 10 * 60 * 1000,
			now,
		);
	});

	it("rethrows persistence failures when throwOnError is set", async () => {
		const now = 61_000;
		const failure = new Error("status write failed");
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthService(
			createStateRepository({
				readHealthSnapshot: vi.fn(() => createSnapshot({ lastCommitAt: 1_000 })),
			}),
			{
				upsert: vi.fn(async () => {
					throw failure;
				}),
			},
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await expect(service.flushSummary({ now, throwOnError: true })).rejects.toBe(
			failure,
		);
		expect(deferMaintenance).not.toHaveBeenCalled();
	});
});

function createSnapshot(
	overrides: Partial<VaultHealthSnapshot> = {},
): VaultHealthSnapshot {
	return {
		vaultId: "vault-1",
		currentCursor: 1,
		entryCount: 1,
		liveBlobCount: 1,
		stagedBlobCount: 0,
		pendingDeleteBlobCount: 0,
		collectiblePendingDeleteBlobCount: 0,
		storageUsedBytes: 10,
		storageLimitBytes: 100,
		activeLocalVaultCount: 1,
		websocketCount: 1,
		oldestStagedBlobAgeMs: null,
		oldestPendingDeleteAgeMs: null,
		lastCommitAt: 1_000,
		lastGcAt: null,
		...overrides,
	};
}

function createStateRepository(
	overrides: Partial<HealthStateStore> = {},
): HealthStateStore {
	return {
		recordGcCompleted: vi.fn(),
		readHealthSnapshot: vi.fn(() => null),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100,
		})),
		...overrides,
	};
}
