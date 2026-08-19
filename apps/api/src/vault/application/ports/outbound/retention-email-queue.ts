import type { VaultInactivityNotice } from "../../../domain/types";

export interface RetentionEmailQueue {
	enqueueDeletionNotice(input: {
		vaultId: string;
		deletedAt: number;
		notice: VaultInactivityNotice;
	}): Promise<void>;
}
