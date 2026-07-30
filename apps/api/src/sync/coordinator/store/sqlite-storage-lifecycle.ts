import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as doSchema from "../../../db/do";
import type { CoordinatorStorageLifecycle } from "../ports";

// `import.meta.url` is a plain string, so this avoids constructing a `URL`
// instance: under this project's Workers tsconfig, the global `URL` type is
// the Workers runtime's, not node:url's, and the two aren't assignable.
const DEFAULT_MIGRATIONS_FOLDER = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../drizzle-do",
);

export class SqliteCoordinatorStorage implements CoordinatorStorageLifecycle {
	constructor(
		private readonly sqlite: Database.Database,
		private readonly migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
	) {}

	async migrate(): Promise<void> {
		const db = drizzle(this.sqlite, { schema: doSchema });
		migrate(db, { migrationsFolder: this.migrationsFolder });
	}

	async purgeVaultState(): Promise<void> {
		this.sqlite.exec(`
			DELETE FROM entry_versions;
			DELETE FROM entries;
			DELETE FROM blobs;
			DELETE FROM maintenance_jobs;
			DELETE FROM local_vault_connections;
			DELETE FROM coordinator_state;
		`);
	}
}
