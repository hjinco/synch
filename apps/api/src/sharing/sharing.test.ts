import { DrizzleVaultStore } from "../vault/adapters/outbound/drizzle-vault-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createLibsqlDb } from "../db/client";
import * as s from "../db/d1";
import { DrizzleSharingStore } from "./adapters/drizzle-sharing-store";
import { createSharingService, type SharingConfig } from "./application/service";
import { EmailInvitationSender } from "./adapters/email-invitation-sender";
import { createSharingFeature } from "../composition/features/create-sharing-feature";
import { SharingAccess } from "./application/access";
import { getSubscriptionPlanPolicy } from "../subscription/domain/policy";

const clients: Client[] = [];
afterEach(() => {
	clients.splice(0).forEach((c) => c.close());
	vi.restoreAllMocks();
});
async function setup(config: Partial<SharingConfig> = {}) {
	const client = createClient({ url: ":memory:" });
	clients.push(client);
	await migrate(drizzle(client), {
		migrationsFolder: fileURLToPath(
			new URL("../../drizzle", import.meta.url).href,
		),
	});
	const db = createLibsqlDb(client);
	const store = new DrizzleSharingStore(db);
	for (const id of ["owner", "alice", "bob", "carol"])
		await db.insert(s.user).values({
			id,
			name: id,
			email: `${id}@example.com`,
			emailVerified: true,
		});
	await db
		.insert(s.organization)
		.values({ id: "org", name: "Team", slug: "team", createdAt: new Date() });
	await db.insert(s.member).values({
		id: "owner-membership",
		userId: "owner",
		organizationId: "org",
		role: "owner",
		createdAt: new Date(),
	});
	for (const id of ["vault-a", "vault-b"]) {
		await db
			.insert(s.vault)
			.values({ id, organizationId: "org", name: id, activeKeyVersion: 1 });
		await db.insert(s.vaultMembership).values({
			vaultId: id,
			userId: "owner",
			isCreator: true,
			status: "active",
		});
	}
	let plan: "plus" | "free" = "plus";
	const policy = {
		readOrganizationPolicy: async () => getSubscriptionPlanPolicy(plan),
	};
	const service = createSharingService(
		store,
		policy,
		{ refreshSharingAccess: async () => {} },
		{ baseURL: "https://example.com", requireVerifiedEmail: true, ...config },
	);
	return {
		db,
		store,
		service,
		access: new SharingAccess(store, policy),
		setPlan: (p: typeof plan) => {
			plan = p;
		},
	};
}
const actor = (id: string) => ({ id, email: `${id}@example.com` });
const wrapper = (userId: string) => ({
	version: 2,
	keyVersion: 1,
	binding: { vaultId: "vault-a", userId },
	kdf: {
		name: "argon2id",
		memoryKiB: 65536,
		iterations: 3,
		parallelism: 1,
		salt: "MDEyMzQ1Njc4OWFiY2RlZg==",
	},
	wrap: {
		algorithm: "aes-256-gcm",
		nonce: "AAECAwQFBgcICQoL",
		ciphertext: "test",
	},
});

describe("organization vault sharing", () => {
	it("retains invitations when email fails and enforces the cooldown before retrying", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const send = vi.fn().mockRejectedValueOnce(new Error("mail unavailable")).mockResolvedValue(undefined);
		const { service, store } = await setup({
			invitationEmail: new EmailInvitationSender({ send }, "Synch <hello@example.com>"),
		});
		const { invite, resend } = service;
		const invitation = await invite(actor("owner"), "org", { email: " Alice@Example.com ", role: "member" });
		expect(invitation.emailSent).toBe(false);
		expect(await store.invitation(invitation.id)).toMatchObject({ email: "alice@example.com", status: "pending" });
		await expect(resend("owner", "org", invitation.id)).rejects.toMatchObject({ code: "delivery_rate_limited" });
		expect(send).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(now + 60_000);
		expect(await resend("owner", "org", invitation.id)).toEqual({ ...invitation, emailSent: true });
		expect(send).toHaveBeenLastCalledWith({
			from: "Synch <hello@example.com>",
			to: "alice@example.com",
			subject: "Invitation to a Synch organization",
			text: `Sign in with this email address to review your Synch invitation:\n\n${invitation.url}\n\nYour vault password and encryption keys are never included in invitations.`,
		});
	});

	it.each([
		{ transport: false, from: undefined, sent: false },
		{ transport: true, from: undefined, sent: false },
		{ transport: false, from: "hello@example.com", sent: false },
		{ transport: true, from: "", sent: false },
		{ transport: true, from: "hello@example.com", sent: true },
	])("wires invitation delivery for $transport / $from", async ({ transport, from, sent }) => {
		const { db } = await setup();
		const send = vi.fn(async () => {});
		const { service } = createSharingFeature({
			db,
			policyReader: { readOrganizationPolicy: async () => getSubscriptionPlanPolicy("plus") },
			invalidator: { refreshSharingAccess: async () => {} },
		}, {
			baseURL: "https://example.com",
			requireVerifiedEmail: true,
			email: transport ? { send } : undefined,
			emailFrom: from,
		});
		const invitation = await service.invite(actor("owner"), "org", { email: "alice@example.com", role: "member" });
		expect(invitation.emailSent).toBe(sent);
		expect(send).toHaveBeenCalledTimes(sent ? 1 : 0);
		if (!sent) {
			expect((await service.resend("owner", "org", invitation.id)).emailSent).toBe(false);
		}
	});

	it("preserves invitation allowlists and recipient verification after service composition", async () => {
		const { service, db, store } = await setup({ allowedEmails: " Alice@Example.com , " });
		await expect(service.invite(actor("owner"), "org", { email: "bob@example.com", role: "member" }))
			.rejects.toMatchObject({ code: "email_not_allowed" });
		expect(await store.invitations("org")).toEqual([]);
		const invitation = await service.invite(actor("owner"), "org", { email: "alice@example.com", role: "member" });
		await db.update(s.user).set({ emailVerified: false }).where(eq(s.user.id, "alice"));
		await expect(service.respond(actor("alice"), invitation.id, true)).rejects.toMatchObject({ code: "verify_email" });
		expect(await store.membership("org", "alice")).toBeNull();
		await db.update(s.user).set({ emailVerified: true }).where(eq(s.user.id, "alice"));
		await service.respond(actor("alice"), invitation.id, true);
		expect(await store.membership("org", "alice")).toMatchObject({ role: "member" });
	});

	it.each(["admin", "member"] as const)("gives %s every current and future vault while requiring key approval", async (role) => {
		const { service, store, db, access } = await setup();
		const invite = await service.invite(actor("owner"), "org", { email: actor("alice").email, role });
		await service.resend("owner", "org", invite.id);
		expect((await service.invitation(actor("alice"), invite.id)).vaults).toHaveLength(2);
		await service.respond(actor("alice"), invite.id, true);
		const vaultStore = new DrizzleVaultStore(db);
		const created = await vaultStore.createVaultForUser("owner", "org", "Later", {
			kind: "password", envelope: { ...wrapper("owner"), version: 1, binding: undefined },
		});
		const org = await service.organization("alice", "org");
		expect(org.vaults).toHaveLength(3);
		expect(org.vaults.every((v) => v.canManage === (role === "admin") && v.status === "pending_key" && !v.personal && v.shared)).toBe(true);
		expect((await vaultStore.listVaultsForUser("alice")).map((v) => v.id)).toContain(created.id);
		expect(await store.grant(created.id, "alice")).toBeNull();
		expect((await service.organization("owner", "org")).vaults.every(v => v.members.some(m => m.userId === "alice" && m.status === "pending_key"))).toBe(true);
		await expect(access.require("alice", "vault-a")).rejects.toMatchObject({ code: "vault_access_denied" });
		expect(await vaultStore.readVaultBootstrapForUser("alice", "vault-a")).toBeNull();
		const request = await service.startKeyRequest("alice", "vault-a", "enrollment", "receiver-key");
		await expect(service.completeKeyRequest("alice", "vault-a", request.id, wrapper("alice"))).rejects.toMatchObject({ code: "request_changed" });
		await service.approveKeyRequest("owner", "vault-a", request.id, { version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "encrypted" });
		await service.completeKeyRequest("alice", "vault-a", request.id, wrapper("alice"));
		expect(await access.require("alice", "vault-a")).toBe(1);
		await expect(access.require("alice", created.id)).rejects.toMatchObject({ code: "vault_access_denied" });
		expect((await service.startKeyRequest("alice", created.id, "future-enrollment", "receiver-key")).purpose).toBe("enrollment");
	});

	it("preserves keys and pending enrollment across role changes while removing management authority", async () => {
		const { service, store, access, db } = await setup();
		const invite = await service.invite(actor("owner"), "org", { email: actor("alice").email, role: "admin" });
		await service.respond(actor("alice"), invite.id, true);
		const request = await service.startKeyRequest("alice", "vault-a", "alice-key", "receiver-key");
		await service.approveKeyRequest("owner", "vault-a", request.id, { version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "encrypted" });
		await service.completeKeyRequest("alice", "vault-a", request.id, wrapper("alice"));
		await service.startKeyRequest("alice", "vault-b", "pending-key", "receiver-key");
		const bob = await service.invite(actor("alice"), "org", { email: actor("bob").email, role: "member" });
		await service.respond(actor("bob"), bob.id, true);
		const bobRequest = await service.startKeyRequest("bob", "vault-a", "bob-key", "bob-key");
		await service.changeMember("owner", "org", "alice", "member");
		expect(await store.passwordWrapper("vault-a", "alice")).toEqual(wrapper("alice"));
		expect(await access.require("alice", "vault-a")).toBe(1);
		expect((await store.keyRequest("pending-key"))?.status).toBe("pending");
		expect((await service.organization("alice", "org")).vaults).toHaveLength(2);
		await expect(service.requireVault("alice", "vault-a", true)).rejects.toMatchObject({ code: "forbidden" });
		await expect(service.approveKeyRequest("alice", "vault-a", bobRequest.id, { version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "encrypted" })).rejects.toMatchObject({ code: "forbidden" });
		await expect(service.invite(actor("alice"), "org", { email: actor("carol").email, role: "member" })).rejects.toMatchObject({ code: "forbidden" });
		expect(await new DrizzleVaultStore(db).readVaultBootstrapForUser("alice", "vault-a")).not.toBeNull();
		await service.changeMember("owner", "org", "alice", "admin");
		expect(await access.require("alice", "vault-a")).toBe(1);
	});

	it("reserves three seats including the owner without requiring any vaults", async () => {
		const { service, store, db } = await setup();
		await db.delete(s.vault);
		const a = await service.invite(actor("owner"), "org", { email: actor("alice").email, role: "member" });
		await service.invite(actor("owner"), "org", { email: actor("bob").email, role: "member" });
		await expect(service.invite(actor("owner"), "org", { email: actor("carol").email, role: "member" })).rejects.toMatchObject({ code: "invitation_conflict" });
		await service.resend("owner", "org", a.id);
		await service.respond(actor("alice"), a.id, true);
		expect(await store.membership("org", "alice")).not.toBeNull();
		expect((await service.organization("alice", "org")).vaults).toEqual([]);
	});

	it("includes existing members with missing or revoked enrollment without reusing revoked keys", async () => {
		const { service, store, db, access } = await setup();
		await db.insert(s.member).values({ id: "existing-member", organizationId: "org", userId: "alice", role: "member", createdAt: new Date() });
		await db.insert(s.vaultMembership).values({ vaultId: "vault-a", userId: "alice", status: "revoked", accessVersion: 4, revokedAt: new Date() });
		await db.insert(s.vaultKeyWrapper).values({ id: "old-key", vaultId: "vault-a", userId: "alice", keyVersion: 1, kind: "password", envelopeJson: wrapper("alice"), revokedAt: new Date() });
		expect((await service.organization("alice", "org")).vaults.map(v => v.status)).toEqual(["pending_key", "pending_key"]);
		const request = await service.startKeyRequest("alice", "vault-a", "new-key", "receiver-key");
		expect(request.accessVersion).toBe(5);
		expect(await store.passwordWrapper("vault-a", "alice")).toBeNull();
		await expect(access.require("alice", "vault-a")).rejects.toMatchObject({ code: "vault_access_denied" });
		await service.startKeyRequest("alice", "vault-b", "second-key", "receiver-key");
		await service.changeMember("owner", "org", "alice");
		expect((await store.keyRequest("new-key"))?.status).toBe("canceled");
		expect((await store.keyRequest("second-key"))?.status).toBe("canceled");
		await expect(service.startKeyRequest("alice", "vault-b", "after-removal", "receiver-key")).rejects.toMatchObject({ code: "forbidden" });
	});
	it("rejects privilege escalation, wrong recipients, foreign vaults and expired invitations", async () => {
		const { service, db, store, setPlan } = await setup();
		await db.insert(s.member).values({
			id: "alice-org",
			organizationId: "org",
			userId: "alice",
			role: "admin",
			createdAt: new Date(),
		});
		await db.insert(s.vaultMembership).values({
			vaultId: "vault-a",
			userId: "alice",
			isCreator: false,
			status: "active",
		});
		await expect(
			service.invite(actor("alice"), "org", {
				email: actor("bob").email,
				role: "admin",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			service.changeMember("alice", "org", "owner"),
		).rejects.toMatchObject({ code: "owner_protected" });
		await db
			.insert(s.organization)
			.values({
				id: "other-org",
				name: "Other",
				slug: "other",
				createdAt: new Date(),
			});
		await db
			.insert(s.member)
			.values({
				id: "other-owner",
				organizationId: "other-org",
				userId: "owner",
				role: "owner",
				createdAt: new Date(),
			});
		await db
			.insert(s.vault)
			.values({
				id: "foreign-vault",
				organizationId: "other-org",
				name: "Foreign",
				activeKeyVersion: 1,
			});
		await db
			.insert(s.vaultMembership)
			.values({
				vaultId: "foreign-vault",
				userId: "owner",
				isCreator: true,
				status: "active",
			});
		await expect(service.startKeyRequest("alice", "foreign-vault", "foreign", "receiver-key")).rejects.toMatchObject({ code: "forbidden" });
		const invite = await service.invite(actor("owner"), "org", {
			email: actor("bob").email,
			role: "member",
		});
		await expect(
			service.respond(actor("carol"), invite.id, true),
		).rejects.toMatchObject({ code: "forbidden" });
		setPlan("free");
		await expect(
			service.respond(actor("bob"), invite.id, true),
		).rejects.toMatchObject({ code: "sharing_unavailable" });
		setPlan("plus");
		await db
			.update(s.invitation)
			.set({ expiresAt: new Date(0) })
			.where(eq(s.invitation.id, invite.id));
		await expect(
			service.respond(actor("bob"), invite.id, true),
		).rejects.toMatchObject({ code: "invitation_unavailable" });
		expect(await store.membership("org", "bob")).toBeNull();
	});
	it("reserves seats and vault quota atomically under concurrent requests", async () => {
		const { service, db, store } = await setup();
		const invites = await Promise.allSettled(
			["alice", "bob", "carol"].map((id) =>
				service.invite(actor("owner"), "org", {
					email: actor(id).email,
					role: "member",
				}),
			),
		);
		expect(
			invites.filter((value) => value.status === "fulfilled"),
		).toHaveLength(2);
		for (const result of invites)
			if (result.status === "fulfilled") {
				const invite = await store.invitation(result.value.id);
				const id = invite!.email.split("@")[0];
				await Promise.allSettled([
					service.respond(actor(id), invite!.id, true),
					service.respond(actor(id), invite!.id, true),
				]);
			}
		expect(await store.members("org")).toHaveLength(3);
		const vaultStore = new DrizzleVaultStore(db);
		const vaults = await Promise.allSettled(
			[0, 1, 2, 3].map((i) =>
				vaultStore.createVaultForUser(
					"owner",
					"org",
					`concurrent-${i}`,
					{
						kind: "password",
						envelope: { ...wrapper("owner"), version: 1, binding: undefined },
					},
					3,
				),
			),
		);
		expect(vaults.filter((value) => value.status === "fulfilled")).toHaveLength(
			1,
		);
		expect(await vaultStore.countVaultsForOrganization("org")).toBe(3);
	});
	it("invalidates stale recovery when the user changes their password and retains failed refresh delivery", async () => {
		const { service, store, db } = await setup();
		const invite = await service.invite(actor("owner"), "org", {
			email: actor("alice").email,
			role: "member",
		});
		await service.respond(actor("alice"), invite.id, true);
		const request = await service.startKeyRequest(
			"alice",
			"vault-a",
			"request-1",
			"public-key",
		);
		await service.approveKeyRequest("owner", "vault-a", request.id, {
			version: 1,
			algorithm: "rsa-oaep-sha256",
			ciphertext: "encrypted",
		});
		await service.completeKeyRequest(
			"alice",
			"vault-a",
			request.id,
			wrapper("alice"),
		);
		const recovery = await service.startKeyRequest(
			"alice",
			"vault-a",
			"recovery",
			"new-key",
		);
		await service.approveKeyRequest("owner", "vault-a", recovery.id, {
			version: 1,
			algorithm: "rsa-oaep-sha256",
			ciphertext: "encrypted",
		});
		const newWrapper = {
			...wrapper("alice"),
			wrap: { ...wrapper("alice").wrap, ciphertext: "new-password-ciphertext" },
		};
		await new DrizzleVaultStore(db).upsertPasswordWrapperForUser(
			"alice",
			"vault-a",
			newWrapper,
		);
		await expect(
			service.completeKeyRequest(
				"alice",
				"vault-a",
				recovery.id,
				wrapper("alice"),
			),
		).rejects.toMatchObject({ code: "request_changed" });
		expect(await store.passwordWrapper("vault-a", "alice")).toEqual(newWrapper);
		const failing = createSharingService(
			store,
			{ readOrganizationPolicy: async () => getSubscriptionPlanPolicy("plus") },
			{
				refreshSharingAccess: async () => {
					throw new Error("unavailable");
				},
			},
			{ baseURL: "https://example.com", requireVerifiedEmail: true },
		);
		expect(
			await failing.changeMember("owner", "org", "alice"),
		).toEqual({ pending: true });
		expect((await store.refreshes()).length).toBeGreaterThan(0);
		expect(await service.flushRefreshes()).toBe(true);
		expect(await store.refreshes()).toHaveLength(0);
	});

	it("enrolls, recovers without changing roles, and does not resurrect a revoked grant", async () => {
		const { service, store, access } = await setup();
		const a = await service.invite(actor("owner"), "org", {
			email: actor("alice").email,
			role: "member",
		});
		await service.respond(actor("alice"), a.id, true);
		const req = await service.startKeyRequest(
			"alice",
			"vault-a",
			"request-1",
			"public-key",
		);
		await service.approveKeyRequest("owner", "vault-a", req.id, {
			version: 1,
			algorithm: "rsa-oaep-sha256",
			ciphertext: "encrypted",
		});
		await service.completeKeyRequest(
			"alice",
			"vault-a",
			req.id,
			wrapper("alice"),
		);
		expect(await access.require("alice", "vault-a")).toBe(1);
		const recovery = await service.startKeyRequest(
			"alice",
			"vault-a",
			"request-2",
			"new-public-key",
		);
		expect(recovery.purpose).toBe("recovery");
		await service.changeMember("owner", "org", "alice");
		await expect(
			service.completeKeyRequest(
				"alice",
				"vault-a",
				recovery.id,
				wrapper("alice"),
			),
		).rejects.toMatchObject({ code: "forbidden" });
		await service.respond(actor("alice"), a.id, true);
		expect((await store.grant("vault-a", "alice"))?.status).toBe("revoked");
		await expect(access.require("alice", "vault-a")).rejects.toMatchObject({
			code: "vault_access_denied",
		});
		const reinvite = await service.invite(actor("owner"), "org", { email: actor("alice").email, role: "member" });
		await service.respond(actor("alice"), reinvite.id, true);
		const renewed = await service.startKeyRequest(
			"alice",
			"vault-a",
			"new-membership",
			"receiver-key",
		);
		await service.approveKeyRequest("owner", "vault-a", renewed.id, {
			version: 1,
			algorithm: "rsa-oaep-sha256",
			ciphertext: "encrypted",
		});
		await service.completeKeyRequest(
			"alice",
			"vault-a",
			renewed.id,
			wrapper("alice"),
		);
		expect(await access.require("alice", "vault-a")).toBeGreaterThan(1);
	});
	it("suspends shared vaults when Plus expires, preserves access records and resumes only active members", async () => {
		const { service, access, setPlan } = await setup();
		const a = await service.invite(actor("owner"), "org", {
			email: actor("alice").email,
			role: "member",
		});
		await service.respond(actor("alice"), a.id, true);
		setPlan("free");
		await expect(access.require("owner", "vault-a")).rejects.toMatchObject({
			code: "sharing_suspended",
		});
		await expect(access.require("owner", "vault-b")).rejects.toMatchObject({ code: "sharing_suspended" });
		expect((await service.organization("alice", "org")).vaults.every(v => v.status === "pending_key")).toBe(true);
		setPlan("plus");
		expect(await access.require("owner", "vault-a")).toBe(1);
	});
});
