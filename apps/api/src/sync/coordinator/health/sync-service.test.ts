import { describe, expect, it, vi } from "vitest";

import { ACTIVE_WITHOUT_RECENT_COMMIT_MS } from "../store/health-store";
import { HealthSyncService } from "./sync-service";
import type { HealthStateStore } from "../ports";
import type { VaultSyncStatusSummary } from "../../health/types";

describe("HealthSyncService", () => {
	it("coalesces delayed health summary flush scheduling", async () => {
		const stateRepository = createStateRepository();
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
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
		const service = new HealthSyncService(
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
			readHealthSummary: vi.fn(() => createSummary({ lastCommitAt: 1_000 })),
		});
		const syncStatusRepository = {
			upsert: vi.fn(async () => {}),
		};
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
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
			readHealthSummary: vi.fn(() => createSummary({ lastCommitAt })),
		});
		const syncStatusRepository = {
			upsert: vi.fn(async () => {}),
		};
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
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

	it("does not arm another flush when no future health deadline remains", async () => {
		const lastCommitAt = 1_000;
		const now = lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		const stateRepository = createStateRepository({
			readHealthSummary: vi.fn(() =>
				createSummary({
					lastCommitAt,
					healthStatus: "warning",
					healthReasons: ["active_without_recent_commit"],
				}),
			),
		});
		const syncStatusRepository = {
			upsert: vi.fn(async () => {}),
		};
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
			stateRepository,
			syncStatusRepository,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await expect(service.flushSummary({ now })).resolves.toBeNull();
		expect(deferMaintenance).not.toHaveBeenCalled();
	});
});

function createSummary(
	overrides: Partial<VaultSyncStatusSummary> = {},
): VaultSyncStatusSummary {
	return {
		vaultId: "vault-1",
		healthStatus: "ok",
		healthReasons: [],
		currentCursor: 1,
		entryCount: 1,
		liveBlobCount: 1,
		stagedBlobCount: 0,
		pendingDeleteBlobCount: 0,
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
		readHealthSummary: vi.fn(() => null),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100,
		})),
		...overrides,
	};
}
