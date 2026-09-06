export interface LocalVaultConnectionStore {
	recordLocalVaultConnection(
		userId: string,
		localVaultId: string,
		now: number,
	): void;
	deleteLocalVaultConnection(userId: string, localVaultId: string): void;
}
