import { DrizzleVaultStore } from "../vault/adapters/outbound/drizzle-vault-store";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createLibsqlDb } from "../db/client";
import * as s from "../db/d1";
import { DrizzleSharingStore } from "./adapters/drizzle-sharing-store";
import { SharingService } from "./application/service";
import { SharingAccess } from "./application/access";
import { getSubscriptionPlanPolicy } from "../subscription/domain/policy";

const clients: Client[] = [];
afterEach(() => {
	clients.splice(0).forEach((c) => c.close());
});
async function setup() {
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
	const service = new SharingService(
		store,
		policy,
		{ refreshSharingAccess: async () => {} },
		{ baseURL: "https://example.com", requireVerifiedEmail: true },
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
const grants = [{ vaultId: "vault-a" }];
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
	it("gives administrators every current and future vault without separate grants", async () => {
		const { service, store, db, access } = await setup();
		const invite = await service.invite(actor("owner"), "org", {
			email: actor("alice").email, role: "admin", vaults: [],
		});
		await service.resend("owner", "org", invite.id);
		expect((await service.invitation(actor("alice"), invite.id)).vaults).toHaveLength(2);
		await service.respond(actor("alice"), invite.id, true);
		const vaultStore = new DrizzleVaultStore(db);
		const created = await vaultStore.createVaultForUser("owner", "org", "Later", {
			kind: "password", envelope: { ...wrapper("owner"), version: 1, binding: undefined },
		});
		const org = await service.organization("alice", "org");
		expect(org.vaults).toHaveLength(3);
		expect(org.vaults.every((v) => v.canManage && v.status === "pending_key" && !v.personal)).toBe(true);
		expect((await vaultStore.listVaultsForUser("alice")).map((v) => v.id)).toContain(created.id);
		expect(await store.grant(created.id, "alice")).toBeNull();
		// Management does not require receiving the encryption key first.
		const bob = await service.invite(actor("alice"), "org", {
			email: actor("bob").email, role: "member", vaults: [{ vaultId: created.id }],
		});
		await service.respond(actor("bob"), bob.id, true);
		await service.changeVaultMember("alice", "vault-b", "bob", true);
		await expect(service.changeVaultMember("owner", created.id, "alice")).rejects.toMatchObject({ code: "forbidden" });
		// Content access still requires the recipient's own encrypted wrapper.
		await expect(access.require("alice", "vault-a")).rejects.toMatchObject({ code: "vault_access_denied" });
		const request = await service.startKeyRequest("alice", "vault-a", "admin-enrollment", "receiver-key");
		expect((await store.grant("vault-a", "alice"))?.explicitAccess).toBe(false);
		await service.approveKeyRequest("owner", "vault-a", request.id, {
			version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "encrypted",
		});
		await service.completeKeyRequest("alice", "vault-a", request.id, wrapper("alice"));
		expect(await access.require("alice", "vault-a")).toBe(1);
		// Current organization role authorizes key sharing, not legacy vault roles.
		await service.changeVaultMember("alice", "vault-a", "bob", true);
		const bobRequest = await service.startKeyRequest("bob", "vault-a", "bob-enrollment", "bob-key");
		await service.approveKeyRequest("alice", "vault-a", bobRequest.id, {
			version: 1, algorithm: "rsa-oaep-sha256", ciphertext: "encrypted",
		});
		await service.changeMember("owner", "org", "alice", "member");
		expect((await store.grant("vault-a", "alice"))?.status).toBe("revoked");
		expect(await store.passwordWrapper("vault-a", "alice")).toBeNull();
		expect((await service.organization("alice", "org")).vaults).toHaveLength(0);
		await expect(access.require("alice", "vault-a")).rejects.toMatchObject({ code: "vault_access_denied" });
		await expect(service.changeVaultMember("alice", "vault-a", "bob")).rejects.toMatchObject({ code: "forbidden" });
	});

	it("preserves explicit member access across promotion and demotion without granting members management rights", async () => {
		const { service, store, db } = await setup();
		const invite = await service.invite(actor("owner"), "org", {
			email: actor("alice").email, role: "member", vaults: grants,
		});
		await service.respond(actor("alice"), invite.id, true);
		await db.update(s.vaultMembership).set({ status: "active" }).where(eq(s.vaultMembership.userId, "alice"));
		await expect(service.requireVault("alice", "vault-a", true)).rejects.toMatchObject({ code: "forbidden" });
		await service.changeMember("owner", "org", "alice", "admin");
		expect((await service.organization("alice", "org")).vaults).toHaveLength(2);
		await service.startKeyRequest("alice", "vault-b", "inherited-key", "receiver-key");
		await service.changeMember("owner", "org", "alice", "member");
		expect((await store.grant("vault-a", "alice"))?.status).toBe("active");
		expect((await store.grant("vault-b", "alice"))?.status).toBe("revoked");
		expect((await store.keyRequest("inherited-key"))?.status).toBe("canceled");
		expect((await service.organization("alice", "org")).vaults.map((v) => v.id)).toEqual(["vault-a"]);
		await service.changeMember("owner", "org", "alice", "admin");
		await service.startKeyRequest("alice", "vault-b", "renewed-key", "new-receiver-key");
		expect((await store.grant("vault-b", "alice"))?.accessVersion).toBeGreaterThan(1);
	});

	it("reserves three seats including the owner and grants only selected vaults after acceptance", async () => {
		const { service, store, access } = await setup();
		const a = await service.invite(actor("owner"), "org", {
			email: actor("alice").email,
			role: "member",
			vaults: grants,
		});
		await service.invite(actor("owner"), "org", {
			email: actor("bob").email,
			role: "member",
			vaults: grants,
		});
		await expect(
			service.invite(actor("owner"), "org", {
				email: actor("carol").email,
				role: "member",
				vaults: grants,
			}),
		).rejects.toMatchObject({ code: "invitation_conflict" });
		await service.respond(actor("alice"), a.id, true);
		expect((await store.grant("vault-a", "alice"))?.status).toBe("pending_key");
		expect(await store.grant("vault-b", "alice")).toBeNull();
		await expect(access.require("alice", "vault-a")).rejects.toMatchObject({
			code: "vault_access_denied",
		});
		const org = await service.organization("alice", "org");
		expect(org.vaults.map((v) => v.id)).toEqual(["vault-a"]);
		expect(org.members.map((m) => m.id)).toEqual(["alice"]);
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
				vaults: grants,
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
		await expect(
			service.invite(actor("owner"), "org", {
				email: actor("bob").email,
				role: "member",
				vaults: [{ vaultId: "foreign-vault" }],
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		const invite = await service.invite(actor("owner"), "org", {
			email: actor("bob").email,
			role: "member",
			vaults: grants,
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
					vaults: grants,
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
			vaults: grants,
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
		const failing = new SharingService(
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
			await failing.changeVaultMember("owner", "vault-a", "alice"),
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
			vaults: grants,
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
		expect((await store.grant("vault-a", "alice"))?.explicitAccess).toBe(true);
		const recovery = await service.startKeyRequest(
			"alice",
			"vault-a",
			"request-2",
			"new-public-key",
		);
		expect(recovery.purpose).toBe("recovery");
		await service.changeVaultMember("owner", "vault-a", "alice");
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
		await service.changeVaultMember(
			"owner",
			"vault-a",
			"alice",
			true,
		);
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
		const { service, store, access, setPlan } = await setup();
		const a = await service.invite(actor("owner"), "org", {
			email: actor("alice").email,
			role: "member",
			vaults: grants,
		});
		await service.respond(actor("alice"), a.id, true);
		setPlan("free");
		await expect(access.require("owner", "vault-a")).rejects.toMatchObject({
			code: "sharing_suspended",
		});
		expect(await access.require("owner", "vault-b")).toBe(1);
		expect((await store.grant("vault-a", "alice"))?.status).toBe("pending_key");
		setPlan("plus");
		expect(await access.require("owner", "vault-a")).toBe(1);
	});
});
