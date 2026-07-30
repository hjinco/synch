export type BlobBody = NonNullable<Request["body"]>;

/**
 * Full blob object storage surface: `BlobObjectRepository` (in
 * `../coordinator/ports.ts`) only covers what the coordinator itself needs
 * (exists/delete/deleteByPrefix) — this adds the upload/download path used by
 * `sync/blob/routes.ts`, shared by every backend (R2, local disk, S3).
 */
export interface BlobStorage {
	upload(key: string, body: BlobBody): Promise<{ size: number }>;
	download(key: string): Promise<ReadableStream | null>;
	delete(key: string): Promise<void>;
	deleteByPrefix(prefix: string): Promise<void>;
	exists(key: string): Promise<boolean>;
}
