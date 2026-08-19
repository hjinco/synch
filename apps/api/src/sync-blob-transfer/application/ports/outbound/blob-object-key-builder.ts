export interface BlobObjectKeyBuilder {
	blobObjectKey(vaultId: string, blobId: string): string;
	blobObjectKeyPrefix(vaultId: string): string;
}
