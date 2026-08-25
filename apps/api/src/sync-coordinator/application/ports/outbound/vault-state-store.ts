import type { SyncPauseState } from "../../dto/sync-repair";
import type { VaultStateLimits } from "../../dto/types";

export type { SyncPauseState };

export interface InitialVaultLimitReader {
	readInitialVaultLimits(vaultId: string): Promise<VaultStateLimits>;
}

export interface VaultStateStore {
	currentCursor(): number;
	ensureVaultState(vaultId: string, initialLimits: VaultStateLimits): void;
	readVaultId(): string | null;
	readSyncPause(): SyncPauseState | null;
	clearSyncPause(): void;
	vaultStateExistsFor(vaultId: string): boolean;
	recordLocalVaultConnection(userId: string, localVaultId: string): void;
	deleteLocalVaultConnection(userId: string, localVaultId: string): void;
	readVaultLimits(): {
		storageLimitBytes: number;
		maxFileSizeBytes: number;
		versionHistoryRetentionDays: number;
	};
	applyVaultPolicy(vaultId: string, limits: VaultStateLimits): boolean;
	readVersionHistoryRetentionDays(): number;
}
