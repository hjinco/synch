import { describe, expect, it } from "vitest";

import {
	apiRequest,
	initializeCoordinatorState,
	issueSyncToken,
	signUpAndCreateVault,
	uniqueId,
} from "../../helpers/api";

describe("blob upload: declared-size enforcement", () => {
	it("rejects an oversized body without consuming the whole stream", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "local-vault-oversize");
		await initializeCoordinatorState(primary.vaultId);
		const blobId = uniqueId("oversize-blob");

		// Declares 1 byte, but streams far more. The native fixed-length stream
		// should stop the source shortly after the declared length.
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

		expect(uploaded.status).toBe(400);
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
