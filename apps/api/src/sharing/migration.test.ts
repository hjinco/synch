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
		for (const migration of migrations.slice(0, -1))
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
		for (const sql of migrations.at(-1)!.sql) await client.execute(sql);
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
