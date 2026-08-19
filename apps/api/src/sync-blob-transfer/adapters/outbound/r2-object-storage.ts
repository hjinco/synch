import type { BlobObjectStorage } from "../../application/ports/outbound/blob-object-storage";
import { limitBodySize } from "./body-size";

const R2_LIST_BATCH_SIZE = 1000;

export class R2BlobObjectStorage implements BlobObjectStorage {
	constructor(private readonly bucket: R2Bucket) {}

	async upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		declaredSizeBytes: number,
	): Promise<{ size: number; sizeMismatch: boolean }> {
		const limited = limitBodySize(body, declaredSizeBytes);
		let object: R2Object | null = null;
		let uploadError: unknown;
		try {
			object = await this.bucket.put(key, limited.readable);
		} catch (error) {
			uploadError = error;
		}
		const sizeMismatch = await limited.sizeMismatch;
		// R2 rejects an aborted FixedLengthStream when the request body is short
		// or oversized. The old route treated that signal as the authoritative
		// declared-size result before considering other upload failures.
		if (sizeMismatch) {
			return { size: object?.size ?? 0, sizeMismatch: true };
		}
		if (uploadError) {
			throw uploadError;
		}
		if (!object) {
			throw new Error("blob upload did not return an R2 object");
		}
		return {
			size: object.size,
			sizeMismatch: sizeMismatch || object.size !== declaredSizeBytes,
		};
	}

	async download(key: string): Promise<ReadableStream<Uint8Array> | null> {
		const object = await this.bucket.get(key);
		return object?.body ?? null;
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		let cursor: string | undefined;
		do {
			const listed = await this.bucket.list({
				prefix,
				cursor,
				limit: R2_LIST_BATCH_SIZE,
			});
			const keys = listed.objects.map((object) => object.key);
			if (keys.length > 0) {
				await this.bucket.delete(keys);
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	}

	async exists(key: string): Promise<boolean> {
		return (await this.bucket.head(key)) !== null;
	}
}
