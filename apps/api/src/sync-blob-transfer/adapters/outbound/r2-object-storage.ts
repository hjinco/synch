import type { BlobObjectStorage } from "../../application/ports/outbound/blob-object-storage";

const R2_LIST_BATCH_SIZE = 1000;

export class R2BlobObjectStorage implements BlobObjectStorage {
	constructor(private readonly bucket: R2Bucket) {}

	async upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		declaredSizeBytes: number,
	): Promise<{ size: number; sizeMismatch: boolean }> {
		const fixed = new FixedLengthStream(declaredSizeBytes);
		const [uploadResult, pipeResult] = await Promise.allSettled([
			this.bucket.put(key, fixed.readable),
			body.pipeTo(fixed.writable),
		]);
		if (
			pipeResult.status === "rejected" &&
			!isFixedLengthStreamError(pipeResult.reason)
		) {
			throw pipeResult.reason;
		}
		if (uploadResult.status === "rejected") {
			// A short fixed-length stream is reported by R2 while it reads the
			// stream, whereas an oversized stream usually rejects pipeTo().
			if (isFixedLengthStreamError(uploadResult.reason)) {
				return { size: 0, sizeMismatch: true };
			}
			throw uploadResult.reason;
		}
		if (pipeResult.status === "rejected") {
			return {
				size: uploadResult.value?.size ?? 0,
				sizeMismatch: true,
			};
		}
		const object = uploadResult.value;
		if (!object) {
			throw new Error("blob upload did not return an R2 object");
		}
		return {
			size: object.size,
			sizeMismatch: object.size !== declaredSizeBytes,
		};
	}

	async download(key: string): Promise<ReadableStream<Uint8Array> | null> {
		const object = await this.bucket.get(key);
		return object?.body ?? null;
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}

	async deleteMany(keys: readonly string[]): Promise<{ failedKeys: readonly string[] }> {
		for (let index = 0; index < keys.length; index += R2_LIST_BATCH_SIZE) {
			const chunk = keys.slice(index, index + R2_LIST_BATCH_SIZE);
			if (chunk.length === 0) {
				continue;
			}
			try {
				await this.bucket.delete([...chunk]);
			} catch (error) {
				if (index === 0) {
					throw error;
				}
				return { failedKeys: keys.slice(index) };
			}
		}
		return { failedKeys: [] };
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
			const { failedKeys } = await this.deleteMany(keys);
			if (failedKeys.length > 0) {
				throw new Error(
					`r2 batch delete failed for ${failedKeys.length} key(s)`,
				);
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	}

	async exists(key: string): Promise<boolean> {
		return (await this.bucket.head(key)) !== null;
	}
}

function isFixedLengthStreamError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "TypeError" &&
		error.message.includes("FixedLengthStream")
	);
}
