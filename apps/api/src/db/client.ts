import { sql } from "drizzle-orm";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import * as schema from "./d1";

/**
 * Portable app-level drizzle handle. Both D1 (Cloudflare) and libSQL (the
 * self-hosted, no-Cloudflare backend) are 'async' result-kind drivers, so
 * code written against this type - including better-auth's drizzle adapter,
 * which awaits query builders directly rather than calling `.all()/.get()` -
 * works unmodified against either. This is deliberately NOT the same choice
 * as the sync coordinator's `CoordinatorDb` (sync/better-sqlite3): this DB
 * doesn't need the DO's single-threaded-transaction atomicity trick, and
 * better-auth's adapter assumes async/thenable query results.
 *
 * `.batch()` is added explicitly on top of the shared `BaseSQLiteDatabase`
 * base: D1 and libSQL each implement it with an identical signature, but it
 * isn't part of the common base class. It's the only portable way to run
 * more than one write atomically here - real interactive transactions
 * (`BEGIN`/`SAVEPOINT`, which drizzle's own `.transaction()` uses) are
 * rejected outright by D1 at runtime ("please use state.storage.transaction()
 * ... instead of the SQL BEGIN TRANSACTION"), even though `.transaction()` is
 * present on the type and compiles fine.
 */
export type AppDb = BaseSQLiteDatabase<"async", unknown, typeof schema> & {
	batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(
		batch: T,
	): Promise<BatchResponse<T>>;
};

export function createDb(database: D1Database): AppDb {
	return drizzleD1(database, {
		schema,
	});
}

export function createLibsqlDb(client: Client): AppDb {
	return drizzleLibsql(client, {
		schema,
	});
}

export async function pingDatabase(db: AppDb): Promise<void> {
	await db.run(sql`select 1`);
}
