import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as doSchema from "../../../db/do";
import type {
	CoordinatorDb,
	CoordinatorSqlCursor,
	CoordinatorSqlValue,
	CoordinatorStorageHandle,
} from "./storage-handle";

export class SqliteCoordinatorStorageHandle implements CoordinatorStorageHandle {
	readonly db: CoordinatorDb;

	constructor(private readonly sqlite: Database.Database) {
		this.db = drizzle(sqlite, { schema: doSchema });
	}

	/**
	 * Mirrors `DurableObjectStorage["sql"]["exec"]`, which runs the statement
	 * immediately regardless of whether the caller reads any rows back.
	 * better-sqlite3 statements are lazy until `.run()/.all()/.get()` is
	 * called, so this executes eagerly here and hands back the already-
	 * materialized rows — a caller that never calls `toArray()`/`one()` (a
	 * bare UPDATE/DELETE) must still have taken effect.
	 */
	exec<T extends Record<string, CoordinatorSqlValue> = Record<string, CoordinatorSqlValue>>(
		query: string,
		...bindings: unknown[]
	): CoordinatorSqlCursor<T> {
		const statement = this.sqlite.prepare<unknown[], T>(query);
		let rows: T[] = [];
		if (statement.reader) {
			rows = statement.all(...bindings);
		} else {
			statement.run(...bindings);
		}
		return {
			toArray: () => rows,
			one: () => {
				if (rows.length !== 1) {
					throw new Error(
						`expected exactly one row for query, got ${rows.length}: ${query}`,
					);
				}
				return rows[0];
			},
		};
	}
}

/**
 * Opens the exclusive per-process SQLite lock: `locking_mode = EXCLUSIVE` plus an
 * immediate write forces SQLite to grab and hold the OS file lock right away
 * instead of lazily on first write. A second process opening the same file will
 * fail here with SQLITE_BUSY instead of silently racing the first. This is a
 * distinct safeguard from the per-vault in-process mutex (`VaultLockRegistry`):
 * it protects against a second *process* touching the file at all, not against
 * concurrent requests within one process.
 */
export function openExclusiveSqliteConnection(filePath: string): Database.Database {
	// A short busy timeout so a file already locked by another process fails
	// fast (per the "fail immediately" requirement) instead of blocking for
	// better-sqlite3's 5s default.
	const sqlite = new Database(filePath, { timeout: 200 });
	try {
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("locking_mode = EXCLUSIVE");
		sqlite.exec("BEGIN IMMEDIATE; COMMIT;");
	} catch (error) {
		sqlite.close();
		throw new Error(
			`failed to acquire exclusive lock on sqlite database at ${filePath}; is another synch process already running against this file?`,
			{ cause: error },
		);
	}
	return sqlite;
}
