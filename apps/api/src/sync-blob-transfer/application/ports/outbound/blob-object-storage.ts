export interface BlobObjectStorage {
	upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		declaredSizeBytes: number,
	): Promise<{ size: number; sizeMismatch: boolean }>;
	download(key: string): Promise<ReadableStream<Uint8Array> | null>;
	delete(key: string): Promise<void>;
	deleteByPrefix(prefix: string): Promise<void>;
	exists(key: string): Promise<boolean>;
}
