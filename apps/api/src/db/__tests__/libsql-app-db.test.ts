import { createClient, type Client } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "../d1";
import { createLibsqlDb, pingDatabase } from "../client";
import { VaultSyncStatusRepository } from "../../sync/health/status-repository";
import type { VaultSyncStatusSummary } from "../../sync/health/types";

/**
 * The app-level DB (users/orgs/vaults/auth) swaps D1 for a local libSQL file
 * on the self-hosted backend. libSQL and D1 both type-check against the same
 * `AppDb` shape, but that's not proof they *behave* the same - the earlier
 * `.transaction()` vs `.batch()` mistake type-checked fine and only failed
 * against real D1 at runtime. This exercises the same query surface
 * (migrations, `.batch()`, and the raw `sql` upsert in
 * VaultSyncStatusRepository) against a real embedded libSQL file instead of
 * assuming type compatibility implies behavioral compatibility.
 */
describe("libSQL app DB", () => {
	let dir: string;
	let client: Client;

	afterEach(async () => {
		client?.close();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function openMigratedDb() {
		dir = mkdtempSync(path.join(tmpdir(), "synch-libsql-app-db-"));
		client = createClient({ url: `file:${path.join(dir, "app.db")}` });
		// drizzle-orm/libsql/migrator's `migrate()` wants the concrete
		// LibSQLDatabase type, not the widened portable `AppDb` - same
		// reasoning as SqliteCoordinatorStorage.migrate() constructing its own
		// concrete drizzle instance rather than reusing a widened handle.
		await migrate(drizzleLibsql(client, { schema }), {
			migrationsFolder: path.resolve(__dirname, "../../../drizzle"),
		});
		return createLibsqlDb(client);
	}

	/** libSQL enforces foreign keys by default (unlike bare better-sqlite3, which needs an explicit PRAGMA) - seed real parents rather than relying on dangling IDs. */
	async function seedOrgAndUser(db: Awaited<ReturnType<typeof openMigratedDb>>) {
		await db.insert(schema.organization).values({
			id: "org-1",
			name: "Org",
			slug: "org-1",
			createdAt: new Date(),
		});
		await db.insert(schema.user).values({
			id: "user-1",
			name: "User",
			email: "user@example.com",
		});
	}

	it("applies the D1 migrations folder to a fresh libSQL file", async () => {
		const db = await openMigratedDb();
		await pingDatabase(db);

		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		);
		const names = tables.rows.map((row) => row.name);
		expect(names).toEqual(expect.arrayContaining(["vault", "user", "organization"]));
	});

	it(".batch() runs multiple inserts atomically and returns per-query results, matching the D1 shape VaultRepository.createVaultForUser depends on", async () => {
		const db = await openMigratedDb();
		await seedOrgAndUser(db);

		const vaultId = crypto.randomUUID();
		const wrapperId = crypto.randomUUID();
		const [rows] = await db.batch([
			db
				.insert(schema.vault)
				.values({
					id: vaultId,
					organizationId: "org-1",
					name: "Test Vault",
					activeKeyVersion: 1,
				})
				.returning(),
			db.insert(schema.vaultKeyWrapper).values({
				id: wrapperId,
				vaultId,
				keyVersion: 1,
				kind: "password",
				userId: "user-1",
				envelopeJson: {
					version: 1,
					keyVersion: 1,
					kdf: {
						name: "argon2id",
						memoryKiB: 65536,
						iterations: 3,
						parallelism: 1,
						salt: "salt",
					},
					wrap: { algorithm: "aes-gcm", nonce: "nonce", ciphertext: "ciphertext" },
				},
			}),
			db.insert(schema.vaultMembership).values({
				vaultId,
				userId: "user-1",
				role: "owner",
				status: "active",
			}),
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: vaultId, name: "Test Vault" });

		const membershipRows = await db
			.select()
			.from(schema.vaultMembership);
		expect(membershipRows).toHaveLength(1);
	});

	it("VaultSyncStatusRepository.upsert's raw sql ON CONFLICT works against libSQL", async () => {
		const db = await openMigratedDb();
		await seedOrgAndUser(db);
		await db.insert(schema.vault).values({
			id: "vault-1",
			organizationId: "org-1",
			name: "Test Vault",
			activeKeyVersion: 1,
		});
		const repository = new VaultSyncStatusRepository(db);
		const summary: VaultSyncStatusSummary = {
			vaultId: "vault-1",
			healthStatus: "ok",
			healthReasons: [],
			currentCursor: 0,
			entryCount: 0,
			liveBlobCount: 0,
			stagedBlobCount: 0,
			pendingDeleteBlobCount: 0,
			storageUsedBytes: 0,
			storageLimitBytes: 100,
			activeLocalVaultCount: 0,
			websocketCount: 0,
			oldestStagedBlobAgeMs: null,
			oldestPendingDeleteAgeMs: null,
			lastCommitAt: null,
			lastGcAt: null,
		};

		await repository.upsert(summary, 1_000);
		await repository.upsert({ ...summary, entryCount: 5 }, 2_000);

		const rows = await client.execute(
			"SELECT entry_count FROM vault_sync_status WHERE vault_id = 'vault-1'",
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]?.entry_count).toBe(5);
	});
});
