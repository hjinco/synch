import type { SharingStore } from "./store";

export interface SharingInvalidator {
	refreshSharingAccess(vaultId: string): Promise<void>;
}

/** Failed work stays durable until a later request or scheduled retry succeeds. */
export async function flushSharingRefreshes(
	store: Pick<SharingStore, "refreshes" | "finishRefresh">,
	invalidator: SharingInvalidator,
): Promise<boolean> {
	let complete = true;
	for (const task of await store.refreshes()) {
		try {
			await invalidator.refreshSharingAccess(task.vaultId);
			// A newer change queued during the refresh must survive this completion.
			await store.finishRefresh(task.vaultId, task.revision);
		} catch (error) {
			complete = false;
			console.error("sharing refresh retry pending", { vaultId: task.vaultId, error });
		}
	}
	return complete;
}
