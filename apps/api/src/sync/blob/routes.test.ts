import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerBlobRoutes } from "./routes";

function buildApp() {
	const blobRepository = {
		upload: vi.fn(),
		download: vi.fn(),
	};
	const app = new Hono();
	registerBlobRoutes(app, {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		syncTokenService: { requireSyncToken: vi.fn().mockResolvedValue(undefined) } as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		blobRepository: blobRepository as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		coordinatorProxyRepository: {} as any,
	});
	return { app, blobRepository };
}

describe("blob routes: id validation", () => {
	it("rejects a blobId that would traverse into another vault's blobs, before touching storage", async () => {
		const { app, blobRepository } = buildApp();

		const response = await app.request("/v1/vaults/vault-1/blobs/..%2Fvault-2%2Fsecret-blob");

		expect(response.status).toBe(400);
		expect(blobRepository.download).not.toHaveBeenCalled();
	});

	it("rejects a vaultId containing a path separator", async () => {
		const { app, blobRepository } = buildApp();

		const response = await app.request("/v1/vaults/vault-1%2Fvault-2/blobs/blob-1");

		expect(response.status).toBe(400);
		expect(blobRepository.download).not.toHaveBeenCalled();
	});

	it("accepts a UUID-shaped blobId", async () => {
		const { app, blobRepository } = buildApp();
		blobRepository.download.mockResolvedValue(new Response("ciphertext").body);

		const response = await app.request(
			"/v1/vaults/vault-1/blobs/550e8400-e29b-41d4-a716-446655440000",
		);

		expect(response.status).toBe(200);
		expect(blobRepository.download).toHaveBeenCalledWith(
			"vault-1/550e8400-e29b-41d4-a716-446655440000",
		);
	});
});
