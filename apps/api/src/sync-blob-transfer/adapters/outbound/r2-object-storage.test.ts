import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { R2BlobObjectStorage } from "./r2-object-storage";

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(expectedLength: number) {
		let received = 0;
		super({
			transform(chunk, controller) {
				received += chunk.byteLength;
				if (received > expectedLength) {
					controller.error(new TypeError("FixedLengthStream overflow"));
					return;
				}
				controller.enqueue(chunk);
			},
			flush(controller) {
				if (received !== expectedLength) {
					controller.error(new TypeError("FixedLengthStream underflow"));
				}
			},
		});
	}
}

describe("R2BlobObjectStorage", () => {
	beforeEach(() => {
		vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	it("deletes keys in R2 batches of 1000", async () => {
		const bucket = {
			delete: vi.fn(async () => {}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);
		const keys = Array.from({ length: 1001 }, (_, index) => `vault-1/blob-${index}`);

		await storage.deleteMany(keys);

		expect(bucket.delete).toHaveBeenNthCalledWith(1, keys.slice(0, 1000));
		expect(bucket.delete).toHaveBeenNthCalledWith(2, keys.slice(1000));
	});

	it("keeps earlier R2 chunks when a later batch fails", async () => {
		const bucket = {
			delete: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("r2 unavailable")),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);
		const keys = Array.from({ length: 1001 }, (_, index) => `vault-1/blob-${index}`);

		await expect(storage.deleteMany(keys)).resolves.toEqual({
			failedKeys: keys.slice(1000),
		});
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

	it("reports the actual size from a native R2 upload", async () => {
		const bucket = {
			put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
				await new Response(body).arrayBuffer();
				return { size: 4 };
			}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);

		await expect(
			storage.upload("vault-1/blob-1", streamOf("hello"), 5),
		).resolves.toEqual({ size: 4, sizeMismatch: true });
	});

	it("stops an oversized body at the native fixed length", async () => {
		const bucket = {
			put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
				await new Response(body).arrayBuffer();
				return { size: 5 };
			}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);

		await expect(
			storage.upload("vault-1/blob-1", streamOf("hello"), 4),
		).resolves.toEqual({ size: 0, sizeMismatch: true });
	});

	it("reports a short body as a size mismatch", async () => {
		const bucket = {
			put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
				await new Response(body).arrayBuffer();
				return { size: 4 };
			}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);

		await expect(
			storage.upload("vault-1/blob-1", streamOf("hell"), 5),
		).resolves.toEqual({ size: 0, sizeMismatch: true });
	});

	it("propagates an unrelated R2 upload failure", async () => {
		const uploadError = new Error("r2 unavailable");
		const bucket = {
			put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
				await new Response(body).arrayBuffer();
				throw uploadError;
			}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);

		await expect(
			storage.upload("vault-1/blob-1", streamOf("hello"), 5),
		).rejects.toBe(uploadError);
	});

	it("propagates an unrelated source stream failure", async () => {
		const sourceError = new Error("body read failed");
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
				controller.error(sourceError);
			},
		});
		const bucket = {
			put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
				const reader = body.getReader();
				const { value } = await reader.read();
				return { size: value?.byteLength ?? 0 };
			}),
		};
		const storage = new R2BlobObjectStorage(bucket as unknown as R2Bucket);

		await expect(storage.upload("vault-1/blob-1", body, 5)).rejects.toBe(sourceError);
	});
});
