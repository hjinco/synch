import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createRuntimeApp } from "../../../src/runtime";
import { apiRequest, issueSyncToken, signUpAndCreateVault, uniqueId } from "../../helpers/api";
import { uploadBlob } from "./helpers";

const ADMIN_TOKEN = "integration-admin-token";

describe("admin sync repair integration", () => {
	it("repairs an unreferenced stale staged blob through the admin API", async () => {
		const primary = await signUpAndCreateVault();
		const syncToken = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"repair-device",
		);
		const blobId = uniqueId("repair-blob");
		await uploadBlob(primary.vaultId, syncToken.token, blobId, "stale blob");

		const now = Date.now();
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE blobs SET created_at = ?, delete_after = ? WHERE blob_id = ?",
				now - 2 * 60 * 60 * 1000,
				now - 60 * 60 * 1000,
				blobId,
			);
			state.storage.sql.exec(
				"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
				now - 60 * 60 * 1000,
				`staged blob ${blobId} remained staged for at least one hour`,
			);
		});

		const pausedToken = await apiRequest("/v1/sync/token", {
			method: "POST",
			headers: { cookie: primary.sessionCookie, "content-type": "application/json" },
			body: JSON.stringify({ vaultId: primary.vaultId, localVaultId: "repair-device" }),
		});
		expect(pausedToken.status).toBe(200); // Temporary legacy upload-quota compatibility.

		const repaired = await adminRepairRequest(primary.vaultId);
		const body = (await repaired.json()) as {
			status: string;
			deletedStagedBlobCount: number;
			remainingStaleStagedBlobCount: number;
		};

		expect(repaired.status).toBe(200);
		expect(body).toMatchObject({
			status: "repaired",
			deletedStagedBlobCount: 1,
			remainingStaleStagedBlobCount: 0,
		});

		const missing = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`,
			{ headers: { authorization: `Bearer ${syncToken.token}` } },
		);
		expect(missing.status).toBe(404);

		const state = await runInDurableObject(stub, async (_instance, durableState) => ({
			pause: durableState.storage.sql
				.exec<{ sync_paused_at: number | null }>(
					"SELECT sync_paused_at FROM coordinator_state WHERE id = 1",
				)
				.toArray()[0]?.sync_paused_at ?? null,
			blob: durableState.storage.sql
				.exec<{ blob_id: string }>("SELECT blob_id FROM blobs WHERE blob_id = ?", blobId)
				.toArray()[0],
		}));
		expect(state.pause).toBeNull();
		expect(state.blob).toBeUndefined();
		const renewed = await issueSyncToken(primary.sessionCookie, primary.vaultId, "repair-device");
		await uploadBlob(primary.vaultId, renewed.token, blobId, "retry after repair");
		const downloaded = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blobId}`, {
			headers: { authorization: `Bearer ${renewed.token}` },
		});
		expect(await downloaded.text()).toBe("retry after repair");

	});
});

async function adminRepairRequest(vaultId: string): Promise<Response> {
	return adminRequest(vaultId, "sync-repair");
}

async function adminRequest(vaultId: string, action: string, reason?: string): Promise<Response> {
	const origin = process.env.BETTER_AUTH_URL ?? "http://localhost";
	const url = new URL(`/admin/v1/vaults/${encodeURIComponent(vaultId)}/${action}`, origin);
	const request = new Request(url, {
		method: action === "sync-state" ? "GET" : "POST",
		body: reason ? JSON.stringify({ reason }) : undefined,
		headers: {
			"content-type": "application/json",
			origin: url.origin,
			referer: `${url.origin}/`,
			authorization: `Bearer ${ADMIN_TOKEN}`,
		},
	});

	return await createRuntimeApp(
		{ ...env, ADMIN_TOKEN } as typeof env,
		request,
	).fetch(request);
}


describe("admin sync pause integration", () => {
	it("allows legacy clients to reconnect and read, rejects uploads with quota, and preserves data", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "pause-device");
		const blobId = uniqueId("pause-blob");
		await uploadBlob(primary.vaultId, token.token, blobId, "keep this ciphertext");
		const headers = { authorization: `Bearer ${token.token}` };
		const socketUrl = `/v1/vaults/${primary.vaultId}/socket`;
		const opened = await apiRequest(socketUrl, { headers: { ...headers, upgrade: "websocket" } });
		expect(opened.status).toBe(101);
		const socket = opened.webSocket!;
		socket.accept();
		const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));

		const paused = await adminRequest(primary.vaultId, "sync-pause", "excessive requests");
		expect(paused.status).toBe(200);
		const pauseState = await paused.json();
		expect(pauseState).toMatchObject({ syncPause: { reason: "manual: excessive requests" } });
		const close = await closed;
		expect(close.code).toBe(1013);
		expect(close.reason).toBe("sync paused for vault repair");
		expect(await (await adminRequest(primary.vaultId, "sync-state")).json()).toEqual(pauseState);
		expect(await (await adminRequest(primary.vaultId, "sync-pause", "retry")).json()).toEqual(pauseState);
		expect((await adminRepairRequest(primary.vaultId)).status).toBe(409);

		const renewed = await issueSyncToken(primary.sessionCookie, primary.vaultId, "pause-device");
		const reconnected = await apiRequest(socketUrl, { headers: { authorization: `Bearer ${renewed.token}`, upgrade: "websocket" } });
		expect(reconnected.status).toBe(101);
		const legacySocket = reconnected.webSocket!;
		legacySocket.accept();
		try {
			const hello = new Promise<MessageEvent>((resolve) => legacySocket.addEventListener("message", resolve, { once: true }));
			legacySocket.send(JSON.stringify({ type: "hello", requestId: "legacy-hello", lastKnownCursor: 0 }));
			expect(JSON.parse(String((await hello).data))).toMatchObject({ type: "hello_ack" });
			const readable = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blobId}`, { headers });
			expect(await readable.text()).toBe("keep this ciphertext");
			const blockedId = uniqueId("blocked");
			const blocked = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blockedId}`, {
				method: "PUT", headers: { ...headers, "x-blob-size": "1" }, body: "x",
			});
			expect(blocked.status).toBe(413);
			expect(await blocked.json()).toMatchObject({ error: "quota_exceeded", reason: "sync_paused" });
			const missing = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blockedId}`, { headers });
			expect(missing.status).toBe(404);
			// Staging must not close the session before the quota response is handled.
			expect(legacySocket.readyState).toBe(WebSocket.OPEN);
			const commit = new Promise<MessageEvent>((resolve) => legacySocket.addEventListener("message", resolve, { once: true }));
			legacySocket.send(JSON.stringify({ type: "commit_mutations", requestId: "blocked-commit", mutations: [{
				mutationId: "blocked", entryId: "entry-blocked", op: "delete", baseRevision: 0,
				blobId: null, encryptedMetadata: "metadata",
			}] }));
			const rejected = JSON.parse(String((await commit).data));
			expect(JSON.stringify(rejected)).toContain("sync_paused");
		} finally {
			legacySocket.close();
		}

		expect(await (await adminRequest(primary.vaultId, "sync-resume")).json()).toEqual({ syncPause: null });
		const downloaded = await apiRequest(`/v1/vaults/${primary.vaultId}/blobs/${blobId}`, { headers });
		expect(await downloaded.text()).toBe("keep this ciphertext");
		await issueSyncToken(primary.sessionCookie, primary.vaultId, "pause-device");
	});
});

it("allows an authorized explicit restart but never resumes through automatic token refresh", async () => {
	const owner = await signUpAndCreateVault();
	const other = await signUpAndCreateVault();
	const token = await issueSyncToken(owner.sessionCookie, owner.vaultId, "restart-device");
	await uploadBlob(owner.vaultId, token.token, uniqueId("restart-blob"), "preserve");
	expect((await adminRequest(owner.vaultId, "sync-pause", "manual restart test")).status).toBe(200);
	const requestToken = (cookie: string, resumeSync?: boolean) => apiRequest("/v1/sync/token", {
		method: "POST", headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ vaultId: owner.vaultId, localVaultId: "restart-device", ...(resumeSync ? { resumeSync } : {}) }),
	});
	await requestToken(owner.sessionCookie);
	expect(await (await adminRequest(owner.vaultId, "sync-state")).json()).toMatchObject({ syncPause: { reason: "manual: manual restart test" } });
	expect((await requestToken(other.sessionCookie, true)).status).toBe(403);
	expect(await (await adminRequest(owner.vaultId, "sync-state")).json()).toMatchObject({ syncPause: { reason: "manual: manual restart test" } });
	expect((await requestToken(owner.sessionCookie, true)).status).toBe(200);
	expect(await (await adminRequest(owner.vaultId, "sync-state")).json()).toEqual({ syncPause: null });

	const stub = env.SYNC_COORDINATOR.getByName(owner.vaultId);
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("UPDATE coordinator_state SET sync_paused_at = 1, sync_pause_reason = 'repair required' WHERE id = 1");
	});
	const repair = await requestToken(owner.sessionCookie, true);
	expect(repair.status).toBe(503);
	expect(await repair.json()).toMatchObject({ error: "sync_paused" });
	expect(await (await adminRequest(owner.vaultId, "sync-state")).json()).toMatchObject({ syncPause: { reason: "repair required" } });
});
