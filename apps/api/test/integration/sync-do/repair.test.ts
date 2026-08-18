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
	});
});

async function adminRepairRequest(vaultId: string): Promise<Response> {
	const origin = process.env.BETTER_AUTH_URL ?? "http://localhost";
	const url = new URL(`/admin/v1/vaults/${encodeURIComponent(vaultId)}/sync-repair`, origin);
	const request = new Request(url, {
		method: "POST",
		headers: {
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
