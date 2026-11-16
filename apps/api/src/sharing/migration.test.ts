import { createLibsqlDb } from "../db/client";
import * as schema from "../db/d1";
import { DrizzleSharingStore } from "./adapters/drizzle-sharing-store";
import { createSharingService } from "./application/service";
import { getSubscriptionPlanPolicy } from "../subscription/domain/policy";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("preserves legacy passwords when migrating existing shared vaults", async () => {
	const client = createClient({ url: ":memory:" });
	try {
		const migrations = readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle", import.meta.url).href,
			),
		});
		for (const migration of migrations.slice(0, 7))
			for (const sql of migration.sql) await client.execute(sql);
		for (const id of ["owner", "member", "removed"]) {
			await client.execute({
				sql: "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,1,1)",
				args: [id, id, id + "@example.com"],
			});
		}
		await client.execute(
			"INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)",
		);
		await client.execute(
			"INSERT INTO vault(id,organization_id,name,active_key_version,created_at) VALUES ('vault','org','Vault',1,1)",
		);
		for (const id of ["owner", "member", "removed"]) {
			await client.execute({
				sql: "INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES (?,'org',?,'member',1)",
				args: [id, id],
			});
			await client.execute({
				sql: "INSERT INTO vault_membership(vault_id,user_id,role,status,joined_at) VALUES ('vault',?,'member',?,1)",
				args: [id, id === "removed" ? "revoked" : "active"],
			});
		}
		await client.execute("UPDATE vault_membership SET role='owner' WHERE user_id='owner'");
		await client.execute(
			"INSERT INTO vault_key_wrapper(id,vault_id,key_version,kind,user_id,envelope_json,created_at) VALUES ('common','vault',1,'password',NULL,'existing ciphertext',1)",
		);
		for (const sql of migrations[7]!.sql) await client.execute(sql);
		expect((await client.execute("PRAGMA table_info(vault_membership)")).rows.map((row) => row.name)).not.toContain("role");
		expect((await client.execute("SELECT user_id,is_creator,explicit_access FROM vault_membership ORDER BY user_id")).rows.map((row) => [row.user_id, row.is_creator, row.explicit_access])).toEqual([
			["member", 0, 1], ["owner", 1, 1], ["removed", 0, 1],
		]);
		const rows = await client.execute(
			"SELECT user_id,envelope_json FROM vault_key_wrapper WHERE user_id IS NOT NULL ORDER BY user_id",
		);
		expect(rows.rows.map((row) => [row.user_id, row.envelope_json])).toEqual([
			["member", "existing ciphertext"],
			["owner", "existing ciphertext"],
		]);
		expect(
			(await client.execute("SELECT shared_at FROM vault")).rows[0].shared_at,
		).toBe(1);
		expect(
			(
				await client.execute("SELECT access_version FROM vault_membership")
			).rows.map((row) => row.access_version),
		).toEqual([1, 1, 1]);
	} finally {
		client.close();
	}
});


it("migrates organization access without changing existing keys or restoring revoked enrollment", async () => {
	const client = createClient({ url: ":memory:" });
	try {
		const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url).href) });
		for (const migration of migrations.slice(0, 8)) {
			for (const sql of migration.sql) await client.execute(sql);
		}
		const db = createLibsqlDb(client);
		for (const id of ["owner", "existing", "revoked", "invited", "outsider"]) {
			await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
		}
		for (const id of ["org", "personal"]) {
			await db.insert(schema.organization).values({ id, name: id, slug: id, createdAt: new Date() });
		}
		for (const id of ["owner", "existing", "revoked"]) {
			await db.insert(schema.member).values({ id, userId: id, organizationId: "org", role: id === "owner" ? "owner" : "member", createdAt: new Date() });
		}
		await db.insert(schema.member).values({ id: "personal-owner", userId: "owner", organizationId: "personal", role: "owner", createdAt: new Date() });
		for (const id of ["shared", "unassigned", "personal"]) {
			await db.insert(schema.vault).values({ id, name: id, organizationId: id === "personal" ? "personal" : "org", activeKeyVersion: 1, sharedAt: id === "shared" ? new Date(1) : null });
		}
		for (const id of ["owner", "existing", "revoked"]) {
			await db.insert(schema.vaultMembership).values({ vaultId: "shared", userId: id, isCreator: id === "owner", status: id === "revoked" ? "revoked" : "active", accessVersion: id === "revoked" ? 4 : 1 });
			await client.execute({ sql: "INSERT INTO vault_key_wrapper (id,vault_id,key_version,kind,user_id,envelope_json,created_at,revoked_at) VALUES (?, 'shared',1,'password',?,'encrypted-wrapper',1,?)", args: [id, id, id === "revoked" ? 1 : null] });
		}
		await db.insert(schema.invitation).values({ id: "pending", organizationId: "org", email: "invited@example.com", role: "member", status: "pending", expiresAt: new Date(Date.now() + 60000), inviterId: "owner" });
		await client.execute("INSERT INTO invitation_vault(invitation_id,vault_id) VALUES ('pending','shared')");
		const wrappersBefore = (await client.execute("SELECT * FROM vault_key_wrapper ORDER BY id")).rows;
		const enrollmentSql = "SELECT vault_id,user_id,is_creator,status,access_version,revoked_at FROM vault_membership ORDER BY user_id";
		const enrollmentBefore = (await client.execute(enrollmentSql)).rows;
		for (const migration of migrations.slice(8)) {
			for (const sql of migration.sql) await client.execute(sql);
		}
		expect((await client.execute("SELECT * FROM vault_key_wrapper ORDER BY id")).rows).toEqual(wrappersBefore);
		expect((await client.execute(enrollmentSql)).rows).toEqual(enrollmentBefore);
		expect((await client.execute("PRAGMA table_info(vault_membership)")).rows.map(row => row.name)).not.toContain("explicit_access");
		expect((await client.execute("SELECT name FROM sqlite_master WHERE name='invitation_vault'")).rows).toEqual([]);
		const store = new DrizzleSharingStore(db);
		expect((await store.vault("shared"))?.sharedAt?.getTime()).toBe(1);
		expect((await store.vault("unassigned"))?.sharedAt).not.toBeNull();
		expect((await store.vault("personal"))?.sharedAt).toBeNull();
		expect((await store.refreshes()).map(task => task.vaultId)).toEqual(["unassigned"]);
		const service = createSharingService(store, { readOrganizationPolicy: async () => getSubscriptionPlanPolicy("self_hosted") }, { refreshSharingAccess: async () => {} }, { baseURL: "https://example.com", requireVerifiedEmail: true });
		expect((await service.organization("existing", "org")).vaults.map(v => [v.id, v.status])).toEqual([["shared", "active"], ["unassigned", "pending_key"]]);
		expect((await service.organization("revoked", "org")).vaults.every(v => v.status === "pending_key")).toBe(true);
		await expect(service.organization("outsider", "org")).rejects.toMatchObject({ code: "forbidden" });
		await service.resend("owner", "org", "pending");
		const actor = { id: "invited", email: "invited@example.com" };
		expect((await service.invitation(actor, "pending")).vaults).toHaveLength(2);
		await service.respond(actor, "pending", true);
		expect((await service.organization("invited", "org")).vaults).toHaveLength(2);
	} finally {
		client.close();
	}
});
