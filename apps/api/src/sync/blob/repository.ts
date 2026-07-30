import type { BlobBody, BlobStorage } from "./storage";

export type { BlobBody };

const R2_LIST_BATCH_SIZE = 1000;

export class BlobRepository implements BlobStorage {
	constructor(private readonly bucket: R2Bucket) {}

	async upload(key: string, body: BlobBody): Promise<{ size: number }> {
		const object = await this.bucket.put(key, body);
		if (!object) {
			throw new Error("blob upload did not return an R2 object");
		}

		return { size: object.size };
	}

	async download(key: string): Promise<ReadableStream | null> {
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
		const object = await this.bucket.head(key);
		return object !== null;
	}
}
