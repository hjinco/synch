import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerBlobTransferRoutes } from "./routes";

function buildApp() {
	const uploadBlob = { uploadBlob: vi.fn(async () => ({ ok: true as const, blobId: "blob-1" })) };
	const downloadBlob = {
		downloadBlob: vi.fn(async () => new Response("ciphertext").body as ReadableStream<Uint8Array>),
	};
	const app = new Hono();
	registerBlobTransferRoutes(app, { uploadBlob, downloadBlob });
	return { app, uploadBlob, downloadBlob };
}

describe("blob transfer routes", () => {
	it("rejects a blob id that could traverse into another vault", async () => {
		const { app, downloadBlob } = buildApp();
		const response = await app.request(
			"/v1/vaults/vault-1/blobs/..%2Fvault-2%2Fsecret-blob",
		);
		expect(response.status).toBe(400);
		expect(downloadBlob.downloadBlob).not.toHaveBeenCalled();
	});

	it("rejects a vault id containing a path separator", async () => {
		const { app, downloadBlob } = buildApp();
		const response = await app.request(
			"/v1/vaults/vault-1%2Fvault-2/blobs/blob-1",
		);
		expect(response.status).toBe(400);
		expect(downloadBlob.downloadBlob).not.toHaveBeenCalled();
	});

	it("passes a safe download id and bearer token to the use case", async () => {
		const { app, downloadBlob } = buildApp();
		const response = await app.request(
			"/v1/vaults/vault-1/blobs/550e8400-e29b-41d4-a716-446655440000",
			{ headers: { authorization: "Bearer token" } },
		);
		expect(response.status).toBe(200);
		expect(downloadBlob.downloadBlob).toHaveBeenCalledWith({
			vaultId: "vault-1",
			blobId: "550e8400-e29b-41d4-a716-446655440000",
			token: "token",
		});
	});
});
