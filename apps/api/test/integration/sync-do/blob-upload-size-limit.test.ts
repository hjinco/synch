import { describe, expect, it } from "vitest";

import {
	apiRequest,
	initializeCoordinatorState,
	issueSyncToken,
	signUpAndCreateVault,
	uniqueId,
} from "../../helpers/api";

describe("blob upload: declared-size enforcement", () => {
	it("rejects a body larger than its declared X-Blob-Size instead of buffering the whole thing", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "local-vault-oversize");
		await initializeCoordinatorState(primary.vaultId);
		const blobId = uniqueId("oversize-blob");

		// Declares 1 byte, but streams far more - R2's put() must be cut off at
		// the declared length rather than absorbing the whole thing first.
		let bytesProduced = 0;
		const oversizedBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (bytesProduced >= 10 * 1024 * 1024) {
					controller.close();
					return;
				}
				const chunk = new Uint8Array(64 * 1024);
				bytesProduced += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});

		const uploaded = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blobId}`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token.token}`,
				"x-blob-size": "1",
			},
			body: oversizedBody,
			// @ts-expect-error required by undici/workerd for streaming request bodies
			duplex: "half",
		});

		expect(uploaded.status).toBeGreaterThanOrEqual(400);
		// The point of the fix: the server must have stopped well short of
		// consuming the full 10 MiB body.
		expect(bytesProduced).toBeLessThan(1024 * 1024);
	});

	it("still accepts a body that matches its declared size", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "local-vault-exact");
		await initializeCoordinatorState(primary.vaultId);
		const blobId = uniqueId("exact-blob");
		const payload = new TextEncoder().encode("exact-size body");

		const uploaded = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blobId}`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token.token}`,
				"x-blob-size": String(payload.byteLength),
			},
			body: payload,
		});

		expect(uploaded.status).toBe(201);
	});
});
