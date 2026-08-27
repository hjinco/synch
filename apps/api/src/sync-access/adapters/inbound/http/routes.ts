import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { displayNameFromAuthenticatedUser, type SessionReader } from "../../../../auth/session";
import type { IssueSyncToken } from "../../../application/ports/inbound/issue-sync-token";
import { createEnsureAuthenticatedSession } from "../../../../platform/http/authenticated-session";

export function registerSyncAccessRoutes(
	app: Hono,
	deps: { syncTokenIssuer: IssueSyncToken; sessionReader: SessionReader },
): void {
	const ensureAuthenticatedSession = createEnsureAuthenticatedSession(deps.sessionReader);
	app.post(
		"/v1/sync/token",
		ensureAuthenticatedSession,
		zValidator(
			"json",
			z.object({
				vaultId: z.string().trim().min(1),
				localVaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const body = c.req.valid("json");
			return c.json(
				await deps.syncTokenIssuer.issueSyncToken({
					userId: c.var.user.id,
					vaultId: body.vaultId,
					localVaultId: body.localVaultId,
					displayName: displayNameFromAuthenticatedUser(c.var.user),
				}),
			);
		},
	);
}
