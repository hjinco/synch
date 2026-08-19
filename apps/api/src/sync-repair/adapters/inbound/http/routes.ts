import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { RunSyncRepair } from "../../../application/ports/inbound/run-sync-repair";

export function registerSyncRepairRoutes(
	app: Hono,
	deps: { runSyncRepair: RunSyncRepair; adminToken?: string },
): void {
	app.post(
		"/admin/v1/vaults/:vaultId/sync-repair",
		zValidator("param", z.object({ vaultId: z.string().trim().min(1) })),
		async (c) => {
			const expectedToken = deps.adminToken?.trim() ?? "";
			if (!expectedToken) {
				return c.json({ error: "not_found" }, 404);
			}
			if (!hasAdminAuthorization(c.req.raw, expectedToken)) {
				return c.json({ error: "unauthorized" }, 401);
			}

			const { vaultId } = c.req.valid("param");
			const result = await deps.runSyncRepair.runSyncRepair(vaultId);
			if (result.status === "manual_repair_required") {
				return c.json(
					{ error: "sync_repair_required", ...result },
					409,
				);
			}
			return c.json(result);
		},
	);
}

function hasAdminAuthorization(request: Request, expectedToken: string): boolean {
	const header = request.headers.get("authorization") ?? "";
	const prefix = "Bearer ";
	return header.startsWith(prefix)
		? constantTimeEqual(header.slice(prefix.length), expectedToken)
		: false;
}

function constantTimeEqual(left: string, right: string): boolean {
	let difference = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}
