import { afterEach, describe, expect, it } from "vitest";

import { CoordinatorHealthStore } from "../../store/health-store";
import { closeAllTestSqliteCoordinators, createSqliteCoordinator, testSession } from "./helpers";

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("sqlite backend: health summary", () => {
	it("reports entry/blob counts and defers to the injected socket counter", async () => {
		const { handle, mutationStore } = await createSqliteCoordinator();
		const healthStore = new CoordinatorHealthStore(handle, { count: () => 3 });

		await mutationStore.commitMutations(
			testSession(),
			{
				type: "commit_mutations",
				requestId: "req-1",
				mutations: [
					{
						mutationId: "m1",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext",
					},
				],
			},
			30 * 60 * 1000,
			24 * 60 * 60 * 1000,
		);

		const summary = healthStore.readHealthSummary(10_000, 30 * 24 * 60 * 60 * 1000);
		expect(summary).toMatchObject({
			vaultId: "vault-1",
			entryCount: 1,
			websocketCount: 3,
		});
	});

	it("tracks health flush retry count across failures and resets on success", async () => {
		const { healthStore } = await createSqliteCoordinator();

		const first = healthStore.recordHealthSummaryFlushFailed(new Error("boom"), 1_000);
		const second = healthStore.recordHealthSummaryFlushFailed(new Error("boom again"), 2_000);
		expect(first).toBe(1);
		expect(second).toBe(2);

		healthStore.recordHealthSummaryFlushed(3_000);
		const third = healthStore.recordHealthSummaryFlushFailed(new Error("boom"), 4_000);
		expect(third).toBe(1);
	});
});
