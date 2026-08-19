import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { SyncRepairResult } from "../../../application";
import { registerCoordinatorAdminRoutes } from "./admin-routes";

function buildApp(adminToken: string | undefined = "admin-token") {
	const result: SyncRepairResult = {
		status: "repaired",
		deletedStagedBlobCount: 1,
		remainingStaleStagedBlobCount: 0,
		nextGcAt: null,
		pause: null,
	};
	const repairSyncState = vi.fn(async (_vaultId: string) => result);
	const app = new Hono();
	registerCoordinatorAdminRoutes(app, {
		coordinatorProxyRepository: { repairSyncState },
		adminToken,
	});
	return { app, repairSyncState };
}

describe("admin sync repair route", () => {
	it("hides the endpoint when no admin token is configured", async () => {
		const { app, repairSyncState } = buildApp("");
		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
		});
		expect(response.status).toBe(404);
		expect(repairSyncState).not.toHaveBeenCalled();
	});

	it("requires the configured bearer token", async () => {
		const { app, repairSyncState } = buildApp();
		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
			headers: { authorization: "Bearer wrong-token" },
		});
		expect(response.status).toBe(401);
		expect(repairSyncState).not.toHaveBeenCalled();
	});

	it("returns the coordinator result", async () => {
		const { app, repairSyncState } = buildApp();
		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
			headers: { authorization: "Bearer admin-token" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "repaired" });
		expect(repairSyncState).toHaveBeenCalledWith("vault-1");
	});

	it("returns a stable conflict for manual repair", async () => {
		const { app, repairSyncState } = buildApp();
		vi.mocked(repairSyncState).mockResolvedValue({
			status: "manual_repair_required",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 1,
			nextGcAt: null,
			pause: { pausedAt: 1, reason: "staged blob remained staged" },
			issue: "referenced_staged_blob",
		});
		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
			headers: { authorization: "Bearer admin-token" },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "sync_repair_required",
			status: "manual_repair_required",
		});
	});
});
