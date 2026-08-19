import { describe, expect, it, vi } from "vitest";

import { R2BlobObjectStorage } from "./r2-object-storage";

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

describe("R2BlobObjectStorage", () => {
	it("deletes all objects under a prefix in R2 list batches", async () => {
		const bucket = {
			list: vi
				.fn()
				.mockResolvedValueOnce({
					objects: [{ key: "vault-1/blob-a" }, { key: "vault-1/blob-b" }],
					truncated: true,
					cursor: "next-page",
				})
				.mockResolvedValueOnce({
					objects: [{ key: "vault-1/blob-c" }],
					truncated: false,
				}),
			delete: vi.fn(async () => {}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);

		await storage.deleteByPrefix("vault-1/");
		expect(bucket.list).toHaveBeenNthCalledWith(1, {
			prefix: "vault-1/",
			cursor: undefined,
			limit: 1000,
		});
		expect(bucket.list).toHaveBeenNthCalledWith(2, {
			prefix: "vault-1/",
			cursor: "next-page",
			limit: 1000,
		});
		expect(bucket.delete).toHaveBeenNthCalledWith(1, ["vault-1/blob-a", "vault-1/blob-b"]);
		expect(bucket.delete).toHaveBeenNthCalledWith(2, ["vault-1/blob-c"]);
	});

	it("reports a matching streamed upload", async () => {
		const bucket = {
			put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
				await new Response(body).arrayBuffer();
				return { size: 5 };
			}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);
		await expect(storage.upload("vault-1/blob-1", streamOf("hello"), 5)).resolves.toEqual({
			size: 5,
			sizeMismatch: false,
		});
	});
});
