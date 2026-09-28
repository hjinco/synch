import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { SessionReader } from "../../auth/session";
import { createEnsureAuthenticatedSession } from "../../platform/http/authenticated-session";
import { vaultKeyEnvelopeSchema } from "../../vault/application/dto/vault-key-envelope";
import type { SharingService } from "../application/service";
import { SharingError } from "../application/types";

const id = z.string().uuid();
const role = z.enum(["admin", "member"]);
const envelope = z
	.object({
		version: z.literal(1),
		algorithm: z.literal("rsa-oaep-sha256"),
		ciphertext: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
	})
	.strict();

export function registerSharingRoutes(
	app: Hono,
	deps: {
		sharing: SharingService;
		sessionReader: SessionReader;
		trustedOrigins: string[];
	},
) {
	const signedIn = createEnsureAuthenticatedSession(deps.sessionReader);
	const sharingPath = (path: string) =>
		/^\/v1\/(organizations|invitations)(\/|$)/.test(path) ||
		/^\/v1\/vaults\/[^/]+\/(grants|members|key-requests)(\/|$)/.test(path);
	const api = new Hono<{
		Variables: { user: import("../../auth/session").AuthenticatedUser };
	}>();
	api.use("*", async (c, next) => {
		if (sharingPath(c.req.path)) return signedIn(c, next);
		await next();
	});
	api.use("*", async (c, next) => {
		const writesUserData =
			sharingPath(c.req.path) ||
			/^\/v1\/(vaults(?:\/[^/]+(?:\/password-wrapper)?)?|billing(?:\/[^/]+)?)$/.test(
				c.req.path,
			);
		if (
			writesUserData &&
			!["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
			!c.req.header("authorization")?.startsWith("Bearer ")
		) {
			const origin = c.req.header("origin");
			if (!origin || !deps.trustedOrigins.includes(origin))
				throw new SharingError(
					403,
					"invalid_origin",
					"Request origin is not trusted",
				);
		}
		await next();
	});
	const service = deps.sharing;
	api.get("/organizations", async (c) =>
		c.json({ organizations: await service.listOrganizations(c.var.user.id) }),
	);
	api.get("/organizations/:orgId", async (c) =>
		c.json(await service.organization(c.var.user.id, c.req.param("orgId"))),
	);
	api.patch(
		"/organizations/:orgId",
		zValidator(
			"json",
			z.object({ name: z.string().trim().min(1).max(100) }).strict(),
		),
		async (c) => {
			await service.rename(
				c.var.user.id,
				c.req.param("orgId"),
				c.req.valid("json").name,
			);
			return c.json({ ok: true });
		},
	);
	api.get("/organizations/:orgId/members", async (c) =>
		c.json({
			members: (await service.organization(c.var.user.id, c.req.param("orgId")))
				.members,
		}),
	);
	api.post(
		"/organizations/:orgId/invitations",
		zValidator(
			"json",
			z
				.object({
					email: z.string().email(),
					role: role.default("member"),
					vaults: z
						.array(z.object({ vaultId: id }).strict())
						.max(100).default([]),
				})
				.strict(),
		),
		async (c) =>
			c.json(
				await service.invite(
					c.var.user,
					c.req.param("orgId"),
					c.req.valid("json"),
				),
				201,
			),
	);
	api.get("/organizations/:orgId/invitations", async (c) =>
		c.json({
			invitations: (
				await service.organization(c.var.user.id, c.req.param("orgId"))
			).invitations,
		}),
	);
	api.post("/organizations/:orgId/invitations/:id/resend", async (c) =>
		c.json(
			await service.resend(
				c.var.user.id,
				c.req.param("orgId"),
				c.req.param("id"),
			),
		),
	);
	api.post("/organizations/:orgId/invitations/:id/cancel", async (c) => {
		await service.cancel(
			c.var.user.id,
			c.req.param("orgId"),
			c.req.param("id"),
		);
		return c.json({ ok: true });
	});
	api.get("/invitations/:id", async (c) =>
		c.json(await service.invitation(c.var.user, c.req.param("id"))),
	);
	api.post("/invitations/:id/accept", async (c) =>
		c.json(await service.respond(c.var.user, c.req.param("id"), true)),
	);
	api.post("/invitations/:id/reject", async (c) =>
		c.json(await service.respond(c.var.user, c.req.param("id"), false)),
	);
	api.patch(
		"/organizations/:orgId/members/:userId",
		zValidator("json", z.object({ role }).strict()),
		async (c) =>
			c.json(
				await service.changeMember(
					c.var.user.id,
					c.req.param("orgId"),
					c.req.param("userId"),
					c.req.valid("json").role,
				),
			),
	);
	api.delete("/organizations/:orgId/members/:userId", async (c) =>
		c.json(
			await service.changeMember(
				c.var.user.id,
				c.req.param("orgId"),
				c.req.param("userId"),
			),
		),
	);
	api.post("/vaults/:vaultId/members", (c) =>
		c.json(
			{
				error: "use_vault_grants",
				message: "Use vault grants and key requests to share a vault",
			},
			410,
		),
	);
	api.post(
		"/vaults/:vaultId/grants",
		zValidator("json", z.object({ userId: z.string().min(1) }).strict()),
		async (c) =>
			c.json(
				await service.changeVaultMember(
					c.var.user.id,
					c.req.param("vaultId"),
					c.req.valid("json").userId,
					true,
				),
			),
	);
	api.delete("/vaults/:vaultId/members/:userId", async (c) =>
		c.json(
			await service.changeVaultMember(
				c.var.user.id,
				c.req.param("vaultId"),
				c.req.param("userId"),
			),
		),
	);
	api.get("/vaults/:vaultId/key-requests", async (c) =>
		c.json({
			requests: await service.listKeyRequests(
				c.var.user.id,
				c.req.param("vaultId"),
			),
		}),
	);
	api.get("/vaults/:vaultId/key-requests/:id", async (c) =>
		c.json(
			await service.getKeyRequest(
				c.var.user.id,
				c.req.param("vaultId"),
				c.req.param("id"),
			),
		),
	);
	api.post(
		"/vaults/:vaultId/key-requests",
		zValidator(
			"json",
			z
				.object({
					id,
					publicKey: z
						.string()
						.min(400)
						.max(1024)
						.regex(/^[A-Za-z0-9+/]+={0,2}$/),
				})
				.strict(),
		),
		async (c) => {
			const input = c.req.valid("json");
			try {
				const key = await crypto.subtle.importKey(
					"spki",
					Uint8Array.from(atob(input.publicKey), (v) => v.charCodeAt(0)),
					{ name: "RSA-OAEP", hash: "SHA-256" },
					false,
					["encrypt"],
				);
				const params = key.algorithm as unknown as {
					modulusLength: number;
					publicExponent: Uint8Array;
				};
				if (
					params.modulusLength !== 3072 ||
					Array.from(params.publicExponent).join(",") !== "1,0,1"
				)
					throw new Error("Invalid key");
			} catch {
				throw new SharingError(
					400,
					"invalid_receiver_key",
					"Invalid receiver key",
				);
			}
			return c.json(
				await service.startKeyRequest(
					c.var.user.id,
					c.req.param("vaultId"),
					input.id,
					input.publicKey,
				),
				201,
			);
		},
	);
	api.post(
		"/vaults/:vaultId/key-requests/:id/approve",
		zValidator("json", z.object({ envelope }).strict()),
		async (c) => {
			await service.approveKeyRequest(
				c.var.user.id,
				c.req.param("vaultId"),
				c.req.param("id"),
				c.req.valid("json").envelope,
			);
			return c.json({ ok: true });
		},
	);
	api.post(
		"/vaults/:vaultId/key-requests/:id/complete",
		zValidator("json", z.object({ envelope: vaultKeyEnvelopeSchema }).strict()),
		async (c) => {
			await service.completeKeyRequest(
				c.var.user.id,
				c.req.param("vaultId"),
				c.req.param("id"),
				c.req.valid("json").envelope,
			);
			return c.json({ ok: true });
		},
	);
	app.route("/v1", api);
}
