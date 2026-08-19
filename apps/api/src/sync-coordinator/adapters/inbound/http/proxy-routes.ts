import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { CoordinatorProxyRepository } from "../../outbound/durable-object-rpc/coordinator-proxy-repository";
import type { SyncTokenClaims } from "../../../../sync-access/application";
import { Hono } from "hono";

export type CoordinatorRequestTokenVerifier = {
	requireSyncToken(request: Request, expectedVaultId?: string): Promise<SyncTokenClaims>;
};

export function registerCoordinatorProxyRoutes(
	app: Hono,
	deps: {
		syncTokenVerifier: CoordinatorRequestTokenVerifier;
		coordinatorProxyRepository: CoordinatorProxyRepository;
	},
): void {
	app.get(
		"/v1/vaults/:vaultId/socket",
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const request = c.req.raw;
			const { vaultId } = c.req.valid("param");

			await deps.syncTokenVerifier.requireSyncToken(request, vaultId);
			return await deps.coordinatorProxyRepository.fetch(vaultId, request);
		},
	);
}
