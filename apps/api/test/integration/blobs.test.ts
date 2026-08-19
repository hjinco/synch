import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { getSubscriptionPlanPolicy } from "../../src/subscription/domain/policy";
import {
	apiRequest,
	initializeCoordinatorState,
	issueSyncToken,
	signUpAndCreateVault,
	uniqueId,
} from "../helpers/api";

describe("blob integration", () => {
	it("rejects blob uploads before the vault sync state is initialized", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"blob-before-state-device",
		);
		const blobId = uniqueId("blob");
		const payload = new TextEncoder().encode("blob before state");

		const rejected = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`,
			{
				method: "PUT",
				headers: {
					authorization: `Bearer ${token.token}`,
					"x-blob-size": String(payload.byteLength),
				},
				body: payload,
			},
		);

		expect(rejected.status).toBe(409);
	});

	it("round-trips blob bytes through the vault blob endpoints", async () => {
		const primary = await signUpAndCreateVault();
		await initializeCoordinatorState(primary.vaultId);
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "blob-device");
		const blobId = uniqueId("blob");
		const payload = new TextEncoder().encode("blob bytes from vitest");

		const uploaded = await apiRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token.token}`,
				"x-blob-size": String(payload.byteLength),
			},
			body: payload,
		});
		expect(uploaded.status).toBe(201);

		const downloaded = await apiRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`, {
			headers: {
				authorization: `Bearer ${token.token}`,
			},
		});
		expect(downloaded.status).toBe(200);
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(payload);

		const missing = await apiRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/missing-blob`, {
			headers: {
				authorization: `Bearer ${token.token}`,
			},
		});
		expect(missing.status).toBe(404);
	});

	it("rejects uploads that would exceed the vault storage quota", async () => {
		const primary = await signUpAndCreateVault();
		const storageLimitBytes = 1_000_000_000;
		await initializeCoordinatorState(primary.vaultId, {
			storageLimitBytes,
		});
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "quota-device");
		const firstBlobId = uniqueId("blob");
		const firstPayload = new TextEncoder().encode("1234");

		const firstUpload = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${firstBlobId}`,
			{
				method: "PUT",
				headers: {
					authorization: `Bearer ${token.token}`,
					"x-blob-size": String(firstPayload.byteLength),
				},
				body: firstPayload,
			},
		);
		expect(firstUpload.status).toBe(201);

		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE coordinator_state SET storage_used_bytes = ? WHERE id = 1",
				storageLimitBytes - 1,
			);
		});

		const secondBlobId = uniqueId("blob");
		const secondPayload = new TextEncoder().encode("12");
		const rejected = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${secondBlobId}`,
			{
				method: "PUT",
				headers: {
					authorization: `Bearer ${token.token}`,
					"x-blob-size": String(secondPayload.byteLength),
				},
				body: secondPayload,
			},
		);
		expect(rejected.status).toBe(413);

		const missing = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${secondBlobId}`,
			{
				headers: {
					authorization: `Bearer ${token.token}`,
				},
			},
		);
		expect(missing.status).toBe(404);
	});

	it("rejects uploads above the free plan file size limit", async () => {
		const primary = await signUpAndCreateVault();
		const freePolicy = getSubscriptionPlanPolicy("free");
		await initializeCoordinatorState(primary.vaultId, freePolicy.limits);
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "size-limit-device");
		const blobId = uniqueId("blob");
		const payload = new TextEncoder().encode("small body");

		const rejected = await apiRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token.token}`,
				"x-blob-size": String(freePolicy.limits.maxFileSizeBytes + 1),
			},
			body: payload,
		});

		expect(rejected.status).toBe(413);
	});

	it("rejects uploads whose declared size does not match R2's stored size", async () => {
		const primary = await signUpAndCreateVault();
		await initializeCoordinatorState(primary.vaultId);
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "size-device");
		const blobId = uniqueId("blob");
		const payload = new TextEncoder().encode("actual bytes");

		const uploaded = await apiRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token.token}`,
				"x-blob-size": String(payload.byteLength + 1),
			},
			body: payload,
		});
		expect(uploaded.status).toBe(400);

		const missing = await apiRequest(`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`, {
			headers: {
				authorization: `Bearer ${token.token}`,
			},
		});
		expect(missing.status).toBe(404);
	});
});
