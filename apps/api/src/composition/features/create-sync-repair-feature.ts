import type { RunSyncRepair } from "../../sync-repair/application";
import { CoordinatorRepairAdapter, type CoordinatorNamespace } from "../../sync-repair/adapters/outbound/coordinator-repair-adapter";
import { RunSyncRepairUseCase } from "../../sync-repair/application/use-cases/run-sync-repair";

export type SyncRepairFeature = {
	runSyncRepair: RunSyncRepair;
};

export function createSyncRepairFeature(config: {
	coordinatorNamespace: CoordinatorNamespace;
}): SyncRepairFeature {
	return {
		runSyncRepair: new RunSyncRepairUseCase(
		new CoordinatorRepairAdapter(config.coordinatorNamespace),
	),
	};
}
