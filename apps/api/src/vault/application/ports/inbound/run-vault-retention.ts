export interface RunVaultRetention {
	run(now?: number): Promise<void>;
}
