import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { SessionReader } from "../../../../auth/session";
import { createEnsureAuthenticatedSession } from "../../../../platform/http/authenticated-session";
import type { VaultService } from "../../../application";
import { vaultKeyEnvelopeSchema } from "../../../application/dto/vault-key-envelope";
import { Hono } from "hono";

export function registerVaultRoutes(
	app: Hono,
	deps: { vaultService: VaultService; sessionReader: SessionReader },
): void {
	const ensureAuthenticatedSession = createEnsureAuthenticatedSession(deps.sessionReader);

	app.get("/v1/vaults", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const includeDeleting = c.req.query("includeDeleting") === "true";
		const vaults = await deps.vaultService.listVaults(user.id, { includeDeleting });

		return c.json({
			vaults: vaults.map((vault) => ({
				id: vault.id,
				organizationId: vault.organizationId,
				name: vault.name,
				activeKeyVersion: vault.activeKeyVersion,
				createdAt: vault.createdAt.toISOString(),
				deletedAt: vault.deletedAt?.toISOString() ?? null,
				deletionStatus: vault.purgeStatus,
				deletionError: vault.purgeError,
			})),
		});
	});

	app.post(
		"/v1/vaults",
		ensureAuthenticatedSession,
		zValidator(
			"json",
			z.object({
				name: z.string().trim().min(1),
				initialWrapper: z.object({
					kind: z.literal("password"),
					envelope: vaultKeyEnvelopeSchema,
				}),
			}),
		),
		async (c) => {
			const user = c.var.user;
			const body = c.req.valid("json");
			const created = await deps.vaultService.createVault(user.id, body.name, body.initialWrapper);

			return c.json(
				{
					vault: {
						id: created.id,
						organizationId: created.organizationId,
						name: created.name,
						activeKeyVersion: created.activeKeyVersion,
						createdAt: created.createdAt.toISOString(),
					},
				},
				201,
			);
		},
	);

	app.get(
		"/v1/vaults/:vaultId/bootstrap",
		ensureAuthenticatedSession,
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const user = c.var.user;
			const { vaultId } = c.req.valid("param");
			const bootstrap = await deps.vaultService.getVaultBootstrap(user.id, vaultId);

			return c.json({
				vault: {
					id: bootstrap.vault.id,
					organizationId: bootstrap.vault.organizationId,
					name: bootstrap.vault.name,
					activeKeyVersion: bootstrap.vault.activeKeyVersion,
					createdAt: bootstrap.vault.createdAt.toISOString(),
				},
				wrappers: bootstrap.wrappers.map((wrapper) => ({
					id: wrapper.id,
					vaultId: wrapper.vaultId,
					keyVersion: wrapper.keyVersion,
					kind: wrapper.kind,
					userId: wrapper.userId,
					envelope: wrapper.envelope,
					createdAt: wrapper.createdAt.toISOString(),
					revokedAt: wrapper.revokedAt?.toISOString() ?? null,
				})),
			});
		},
	);

	app.delete(
		"/v1/vaults/:vaultId",
		ensureAuthenticatedSession,
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const user = c.var.user;
			const { vaultId } = c.req.valid("param");
			const result = await deps.vaultService.deleteVault(user.id, vaultId);

			return c.json(
				{
					vault: {
						id: result.vaultId,
						deletionStatus: result.deletionStatus,
					},
				},
				202,
			);
		},
	);

	app.put(
		"/v1/vaults/:vaultId/password-wrapper",
		ensureAuthenticatedSession,
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		zValidator(
			"json",
			z.object({
				envelope: vaultKeyEnvelopeSchema,
			}),
		),
		async (c) => {
			const user = c.var.user;
			const { vaultId } = c.req.valid("param");
			const body = c.req.valid("json");
			const wrapper = await deps.vaultService.replacePasswordWrapper(
				user.id,
				vaultId,
				body.envelope,
			);

			return c.json({
				wrapper: {
					id: wrapper.id,
					vaultId: wrapper.vaultId,
					keyVersion: wrapper.keyVersion,
					kind: wrapper.kind,
					userId: wrapper.userId,
					envelope: wrapper.envelope,
					createdAt: wrapper.createdAt.toISOString(),
					revokedAt: wrapper.revokedAt?.toISOString() ?? null,
				},
			});
		},
	);

	app.post(
		"/v1/vaults/:vaultId/members",
		ensureAuthenticatedSession,
		zValidator(
			"param",
			z.object({
				vaultId: z.string().trim().min(1),
			}),
		),
		zValidator(
			"json",
			z.object({
				userId: z.string().trim().min(1),
				role: z.enum(["admin", "member"]),
				memberWrapper: z.object({
					kind: z.literal("member"),
					envelope: vaultKeyEnvelopeSchema,
				}),
			}),
		),
		async (c) => {
			const user = c.var.user;
			const { vaultId } = c.req.valid("param");
			const body = c.req.valid("json");
			const wrapper = await deps.vaultService.grantVaultAccess(user.id, vaultId, body);

			return c.json(
				{
					wrapper: {
						id: wrapper.id,
						vaultId: wrapper.vaultId,
						keyVersion: wrapper.keyVersion,
						kind: wrapper.kind,
						userId: wrapper.userId,
						envelope: wrapper.envelope,
						createdAt: wrapper.createdAt.toISOString(),
						revokedAt: wrapper.revokedAt?.toISOString() ?? null,
					},
				},
				201,
			);
		},
	);
}
