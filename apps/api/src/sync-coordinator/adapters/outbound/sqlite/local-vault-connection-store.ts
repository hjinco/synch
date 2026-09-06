import { and, eq } from "drizzle-orm";
import * as doSchema from "../../../../db/do";
import type { CoordinatorStorageHandle } from "./storage-handle";
export class CoordinatorLocalVaultConnectionStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}
	recordLocalVaultConnection(
		userId: string,
		localVaultId: string,
		now: number,
	): void {
		this.handle.db
			.insert(doSchema.localVaultConnections)
			.values({
				userId,
				localVaultId,
				lastConnectedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					doSchema.localVaultConnections.userId,
					doSchema.localVaultConnections.localVaultId,
				],
				set: {
					lastConnectedAt: now,
				},
			})
			.run();
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
}
