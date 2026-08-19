/** Shared physical object-key construction for blob storage adapters. */
export function blobObjectKey(vaultId: string, blobId: string): string {
	return `${blobObjectKeyPrefix(vaultId)}${blobId}`;
}

export function blobObjectKeyPrefix(vaultId: string): string {
	return `${vaultId}/`;
}
