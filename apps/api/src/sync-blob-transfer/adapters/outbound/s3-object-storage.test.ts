import { describe, expect, it } from "vitest";

import { S3BlobObjectStorage } from "./s3-object-storage";

describe("S3BlobObjectStorage", () => {
	it("rejects traversal keys before issuing a request", async () => {
		const storage = new S3BlobObjectStorage({
			endpoint: "http://localhost:9000",
			bucket: "test",
			accessKeyId: "test",
			secretAccessKey: "test",
		});
		await expect(
			storage.download("vault-1/../vault-2/blob-secret"),
		).rejects.toThrow(/must not contain "\." or "\.\." segments/);
	});
});
