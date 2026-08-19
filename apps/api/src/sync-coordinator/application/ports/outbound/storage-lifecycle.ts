export interface CoordinatorStorageLifecycle {
	migrate(): Promise<void>;
	purgeVaultState(): Promise<void>;
}
