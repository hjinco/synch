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
	const readSyncPause = vi.fn(async () => null);
	const setSyncPause = vi.fn(async (_vaultId: string, _reason: string | null) => Response.json({ syncPause: null }));
	const app = new Hono();
	registerCoordinatorAdminRoutes(app, {
		coordinatorProxyRepository: { repairSyncState, readSyncPause, setSyncPause },
		adminToken,
	});
	return { app, repairSyncState, readSyncPause, setSyncPause };
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


describe("admin sync pause routes", () => {
	it.each(["sync-state", "sync-pause", "sync-resume"])("authenticates %s before coordinator access", async (action) => {
		for (const [token, status] of [["", 404], ["admin-token", 401]] as const) {
			const { app, setSyncPause, readSyncPause } = buildApp(token);
			const response = await app.request(`/admin/v1/vaults/vault-1/${action}`, { method: action === "sync-state" ? "GET" : "POST" });
			expect(response.status).toBe(status);
			expect(setSyncPause).not.toHaveBeenCalled();
			expect(readSyncPause).not.toHaveBeenCalled();
		}
	});

	it("validates the reason and forwards pause and resume", async () => {
		const { app, setSyncPause } = buildApp();
		const headers = { authorization: "Bearer admin-token", "content-type": "application/json" };
		const invalid = await app.request("/admin/v1/vaults/vault-1/sync-pause", { method: "POST", headers, body: JSON.stringify({ reason: " " }) });
		expect(invalid.status).toBe(400);
		expect(setSyncPause).not.toHaveBeenCalled();
		const paused = await app.request("/admin/v1/vaults/vault-1/sync-pause", { method: "POST", headers, body: JSON.stringify({ reason: "excessive requests" }) });
		expect(paused.status).toBe(200);
		expect(setSyncPause).toHaveBeenLastCalledWith("vault-1", "excessive requests");
		const resumed = await app.request("/admin/v1/vaults/vault-1/sync-resume", { method: "POST", headers });
		expect(resumed.status).toBe(200);
		expect(setSyncPause).toHaveBeenLastCalledWith("vault-1", null);
	});
});
