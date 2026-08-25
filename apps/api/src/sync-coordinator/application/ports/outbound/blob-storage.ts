export interface BlobObjectRepository {
	exists(key: string): Promise<boolean>;
	delete(key: string): Promise<void>;
	deleteMany(keys: readonly string[]): Promise<{ failedKeys: readonly string[] }>;
	deleteByPrefix(prefix: string): Promise<void>;
}

export interface BlobObjectKeyBuilder {
	blobObjectKey(vaultId: string, blobId: string): string;
	blobObjectKeyPrefix(vaultId: string): string;
}
