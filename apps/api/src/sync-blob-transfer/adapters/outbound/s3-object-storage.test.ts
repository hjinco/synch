import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { S3BlobObjectStorage, s3DeleteResultErrorKeys } from "./s3-object-storage";

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

	it("extracts failed keys from a DeleteObjects result", () => {
		expect(
			s3DeleteResultErrorKeys(
				`<DeleteResult>
					<Deleted><Key>vault-1/ok</Key></Deleted>
					<Error><Key>vault-1/failed</Key><Code>AccessDenied</Code></Error>
					<Error><Key>vault-1/also-failed</Key><Code>InternalError</Code></Error>
				</DeleteResult>`,
			),
		).toEqual(["vault-1/failed", "vault-1/also-failed"]);
	});

	it("sends the request body checksum for bulk deletes", async () => {
		const fetchMock = vi.fn(async (request: Request) => {
			const body = await request.text();
			expect(request.headers.get("content-md5")).toBe(
				createHash("md5").update(body).digest("base64"),
			);
			return new Response("<DeleteResult />");
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const storage = new S3BlobObjectStorage({
				endpoint: "http://localhost:9000",
				bucket: "test",
				accessKeyId: "test",
				secretAccessKey: "test",
			});
			await expect(storage.deleteMany(["vault-1/blob-1"])).resolves.toEqual({
				failedKeys: [],
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
