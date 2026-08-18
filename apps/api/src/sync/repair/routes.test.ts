import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { SyncRepairResult } from "../coordinator/ports";
import { registerSyncRepairRoutes } from "./routes";

function buildApp(adminToken: string | undefined = "admin-token") {
	const coordinatorProxyRepository = {
		repairSyncState: vi.fn(async () => ({
			status: "repaired" as const,
			deletedStagedBlobCount: 1,
			remainingStaleStagedBlobCount: 0,
			nextGcAt: null,
			pause: null,
		})),
	};
	const app = new Hono();
	registerSyncRepairRoutes(app, {
		coordinatorProxyRepository: coordinatorProxyRepository as never,
		adminToken,
	});
	return { app, coordinatorProxyRepository };
}

describe("admin sync repair route", () => {
	it("is disabled when no admin token is configured", async () => {
		const { app, coordinatorProxyRepository } = buildApp("");

		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
		});

		expect(response.status).toBe(404);
		expect(coordinatorProxyRepository.repairSyncState).not.toHaveBeenCalled();
	});

	it("requires the configured bearer token", async () => {
		const { app, coordinatorProxyRepository } = buildApp();

		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
			headers: { authorization: "Bearer wrong-token" },
		});

		expect(response.status).toBe(401);
		expect(coordinatorProxyRepository.repairSyncState).not.toHaveBeenCalled();
	});

	it("proxies a repair request with the admin token", async () => {
		const { app, coordinatorProxyRepository } = buildApp();

		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
			headers: { authorization: "Bearer admin-token" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "repaired",
			deletedStagedBlobCount: 1,
		});
		expect(coordinatorProxyRepository.repairSyncState).toHaveBeenCalledWith("vault-1");
	});

	it("returns a stable conflict when repair needs manual intervention", async () => {
		const { app, coordinatorProxyRepository } = buildApp();
		vi.mocked(coordinatorProxyRepository.repairSyncState).mockImplementation(async () => ({
			status: "manual_repair_required",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 1,
			nextGcAt: null,
			pause: { pausedAt: 1, reason: "staged blob blob-1 remained staged for at least one hour" },
			issue: "referenced_staged_blob",
		} satisfies SyncRepairResult));

		const response = await app.request("/admin/v1/vaults/vault-1/sync-repair", {
			method: "POST",
			headers: { authorization: "Bearer admin-token" },
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "sync_repair_required",
			status: "manual_repair_required",
			issue: "referenced_staged_blob",
		});
	});
});
