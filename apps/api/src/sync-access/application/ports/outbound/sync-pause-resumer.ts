export interface SyncPauseResumer {
	resumeSync(vaultId: string): Promise<void>;
}
