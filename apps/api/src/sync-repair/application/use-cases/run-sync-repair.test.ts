import { describe, expect, it, vi } from "vitest";

import { RunSyncRepairUseCase } from "./run-sync-repair";

describe("RunSyncRepairUseCase", () => {
	it("delegates the vault id to the coordinator repair port", async () => {
		const result = {
			status: "repaired" as const,
			deletedStagedBlobCount: 1,
			remainingStaleStagedBlobCount: 0,
			nextGcAt: null,
			pause: null,
		};
		const coordinator = { repairSyncState: vi.fn(async () => result) };
		const useCase = new RunSyncRepairUseCase(coordinator);

		await expect(useCase.runSyncRepair("vault-1")).resolves.toEqual(result);
		expect(coordinator.repairSyncState).toHaveBeenCalledWith("vault-1");
	});
});
